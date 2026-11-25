// Program windows have no plugin actions: the machine side serves the
// agent protocol's op gui (#shared/proto/agentproto, Op.GUI), whose
// actions (status, install, start, pick, shells, video, video-install,
// keep, attach) the hub sends as the header's action, as with the Go
// machine build (features/gui/agent.ts is the hub's side).
import { defineProtocol } from '#shared/proto/protocol.ts';

export const guiProtocol = defineProtocol('gui', {});
