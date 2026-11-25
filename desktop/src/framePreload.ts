// Preload of the app's windows other than the main one (program windows,
// VS Code's own windows), in each of their frames: the channels to the
// core only (frames.ts). The desktopShell bridge is the main window's.
import { setUpFrame } from './frames';

setUpFrame({ origin: self.origin, pathname: location.pathname });
