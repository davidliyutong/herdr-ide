import { checkBuilt } from './paths';
import { sweepLeftovers } from './instance';

export default function globalSetup() {
  checkBuilt();
  sweepLeftovers();
}
