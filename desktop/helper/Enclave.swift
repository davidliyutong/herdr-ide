// The desktop app's Secure Enclave helper for the variable vault's unlock
// key (desktop/src/enclave.ts runs it). It is a small app bundle inside the
// desktop app's Contents/Helpers, so that the Touch ID sheet names it, and it
// keeps nothing: the shell keeps the key's blob through the core.
//
// One JSON line on stdin (at most 64 KiB), one on stdout, exit 0:
//
//   {"op":"available"}  -> {"ok":true,"enclave":bool,"biometry":bool}
//   {"op":"create"}     -> {"ok":true,"blob":b64u,"pub":b64u}
//       A P-256 key-agreement key in the Secure Enclave, usable only after
//       Touch ID with the fingerprints enrolled now, on this device while it
//       is unlocked. No prompt. pub is X9.63 (65 bytes).
//   {"op":"agree","blob":b64u,"peer":b64u,"reason":string}
//       -> {"ok":true,"secret":b64u}
//       After a Touch ID prompt with reason: the raw ECDH secret (32 bytes)
//       of the blob's key and peer (X9.63).
//
// A failure is {"ok":false,"error":"cancel"|"invalidated"|"unavailable"|"failed"}:
// the user or the system cancelled; the key no longer works (the enrolled
// fingerprints changed, a blob the Enclave does not open), only for the
// errors that say so (classify); no Secure Enclave or no Touch ID; anything
// else. The shell ends its unlock entry on invalidated only, and keeps it on
// failed, so an error this helper does not know never ends an entry.

import CryptoKit
import CryptoTokenKit
import Foundation
import LocalAuthentication
import Security

let maxInput = 64 * 1024
let maxReason = 512

func reply(_ object: [String: Any]) -> Never {
  var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data(#"{"error":"failed","ok":false}"#.utf8)
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func fail(_ error: String) -> Never {
  reply(["ok": false, "error": error])
}

func base64url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

func fromBase64url(_ value: Any?) -> Data? {
  guard let text = value as? String, !text.isEmpty, text.count <= maxInput else { return nil }
  let alphabet = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
  guard text.allSatisfy({ alphabet.contains($0) }) else { return nil }
  var padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while padded.count % 4 != 0 { padded += "=" }
  return Data(base64Encoded: padded)
}

/// The request: the first line of stdin, at most maxInput bytes.
func readRequest() -> [String: Any]? {
  var input = Data()
  let stdin = FileHandle.standardInput
  while input.count <= maxInput {
    guard let chunk = try? stdin.read(upToCount: maxInput + 1 - input.count), !chunk.isEmpty else { break }
    input.append(chunk)
    if let newline = input.firstIndex(of: 0x0A) {
      input = input.prefix(upTo: newline)
      break
    }
  }
  guard input.count <= maxInput else { return nil }
  return (try? JSONSerialization.jsonObject(with: input)) as? [String: Any]
}

/// Whether Touch ID can be asked for now: a sensor and enrolled fingerprints,
/// not locked out. Asks nothing.
func biometryAvailable(_ context: LAContext) -> Bool {
  var error: NSError?
  return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
}

/// The failure an error of LocalAuthentication, CryptoTokenKit, the Security
/// framework or CryptoKit is, looking through its underlying errors.
///
/// invalidated only for the codes whose documented meaning is that the key
/// the blob names is gone or the blob cannot be read: CryptoTokenKit's
/// TKError.Code.objectNotFound ("the object was not found": the Secure
/// Enclave no longer has the key, as after the fingerprints of
/// .biometryCurrentSet changed) and .corruptedData ("the data is corrupted":
/// a blob it does not open), and the Security framework's errSecItemNotFound
/// ("the item cannot be found") and errSecDecode ("unable to decode the
/// provided data"). LAError.biometryNotEnrolled is not one: no fingerprints
/// now (unavailable) may be fingerprints again later, and the key's own
/// invalidation then shows as one of the codes above. Every other error is
/// failed.
func classify(_ error: Error) -> String {
  var current: NSError? = error as NSError
  var depth = 0
  while let e = current, depth < 8 {
    switch e.domain {
    case LAErrorDomain:
      switch LAError.Code(rawValue: e.code) {
      case .userCancel, .systemCancel, .appCancel, .userFallback:
        return "cancel"
      case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet, .notInteractive:
        return "unavailable"
      default:
        break
      }
    case TKError.errorDomain:
      switch TKError.Code(rawValue: e.code) {
      case .canceledByUser:
        return "cancel"
      case .corruptedData, .objectNotFound:
        return "invalidated"
      case .tokenNotFound:
        return "unavailable"
      default:
        break
      }
    case NSOSStatusErrorDomain:
      switch OSStatus(e.code) {
      case errSecUserCanceled:
        return "cancel"
      case errSecItemNotFound, errSecDecode:
        return "invalidated"
      case errSecNotAvailable:
        return "unavailable"
      default:
        break
      }
    default:
      break
    }
    current = e.userInfo[NSUnderlyingErrorKey] as? NSError
    depth += 1
  }
  return "failed"
}

func available() -> Never {
  reply(["ok": true, "enclave": SecureEnclave.isAvailable, "biometry": biometryAvailable(LAContext())])
}

func create() -> Never {
  guard SecureEnclave.isAvailable, biometryAvailable(LAContext()) else { fail("unavailable") }
  var error: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error)
  else {
    error?.release()
    fail("failed")
  }
  do {
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(compactRepresentable: false, accessControl: access)
    reply(["ok": true, "blob": base64url(key.dataRepresentation), "pub": base64url(key.publicKey.x963Representation)])
  } catch {
    fail(classify(error))
  }
}

func agree(_ request: [String: Any]) -> Never {
  guard
    let blob = fromBase64url(request["blob"]),
    let peerBytes = fromBase64url(request["peer"]), peerBytes.count == 65,
    let reason = request["reason"] as? String, !reason.isEmpty, reason.count <= maxReason,
    let peer = try? P256.KeyAgreement.PublicKey(x963Representation: peerBytes)
  else { fail("failed") }
  guard SecureEnclave.isAvailable else { fail("unavailable") }
  let context = LAContext()
  // Every agreement asks: no reuse of an earlier Touch ID or device unlock.
  context.touchIDAuthenticationAllowableReuseDuration = 0
  context.localizedReason = reason
  guard biometryAvailable(context) else { fail("unavailable") }
  let key: SecureEnclave.P256.KeyAgreement.PrivateKey
  do {
    key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
  } catch {
    fail(classify(error))
  }
  do {
    let secret = try key.sharedSecretFromKeyAgreement(with: peer)
    let raw = secret.withUnsafeBytes { Data($0) }
    guard raw.count == 32 else { fail("failed") }
    reply(["ok": true, "secret": base64url(raw)])
  } catch {
    fail(classify(error))
  }
}

guard let request = readRequest(), let op = request["op"] as? String else { fail("failed") }
switch op {
case "available": available()
case "create": create()
case "agree": agree(request)
default: fail("failed")
}
