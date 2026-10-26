import { LEGACY_CORE, RUNOVA_CORE } from './coreLayout';

/**
 * The core's program in a root or login shell command, whichever layout the server is in: the
 * new path when it is there, the old one otherwise. A migrated server has both (the old one is a
 * link), so this always finds the program that runs.
 */
export const CORE_PROGRAM = `"$( [ -x ${RUNOVA_CORE.binaryPath} ] && echo ${RUNOVA_CORE.binaryPath} || echo ${LEGACY_CORE.binaryPath} )"`;
