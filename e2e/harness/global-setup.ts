import { checkBuilt } from './paths';
import { sweepLeftovers } from './home';
import { sshUnavailable, sweepContainers } from './sshd';

export default function globalSetup() {
  checkBuilt();
  sweepLeftovers();
  // Throws with E2E_REQUIRE_DOCKER set (CI) when SSH machines cannot run.
  const why = sshUnavailable();
  if (why) console.warn(`SSH machine tests skip: ${why}`);
  else sweepContainers();
}
