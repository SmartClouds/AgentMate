// The runtime bundle's entry: installs Studio on the scene page before the scene's own script.
import { installRuntime } from './runtime.js';

installRuntime(window as Parameters<typeof installRuntime>[0]);
