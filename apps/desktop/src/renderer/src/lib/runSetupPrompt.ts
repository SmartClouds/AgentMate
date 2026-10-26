/** What a fresh "Create with AI" dialog starts with, so Start works even before anything is typed. */
export const DEFAULT_RUN_SETUP_REQUEST =
  'Work out how to run this project and create a run command for it.';

/** A request is one or two sentences. Anything past this is a paste that would bury the rules. */
const MAX_REQUEST_LENGTH = 2000;

export interface RunSetupPromptInput {
  request: string;
  projectName: string;
  folderPath: string;
  platform: string;
}

/** What the agent needs to know about the terminal its suggestion will be typed into. */
function shellNotes(platform: string): string {
  if (platform === 'win32') {
    return [
      'The terminal is Windows PowerShell 5.1 and it starts in the project folder.',
      "Chain commands with ';' because && does not work there.",
      'Use Push-Location <folder>; <command>; Pop-Location when the command has to run in another folder.',
      'A script in the project folder is started with .\\name.bat.',
    ].join(' ');
  }
  return [
    'The terminal is a POSIX shell and it starts in the project folder.',
    'Chain commands with && and use cd <folder> && <command> when the command has to run in another folder.',
    'A script in the project folder is started with ./name.sh.',
  ].join(' ');
}

/**
 * The instruction sent to the agent when a run setup starts. The person only writes what they
 * want, so everything else the agent needs is here: where to look, which tool to call, how the
 * command will be run, and that nothing happens before they approve it.
 */
export function buildRunSetupPrompt({
  request,
  projectName,
  folderPath,
  platform,
}: RunSetupPromptInput): string {
  const wanted = request.trim().slice(0, MAX_REQUEST_LENGTH) || DEFAULT_RUN_SETUP_REQUEST;
  return [
    `Runova asked you to set up a run command for the project "${projectName}". The project folder is ${folderPath}.`,
    '',
    'What the user asked for:',
    wanted,
    '',
    'How to do it:',
    '1. Read the project to find out how it runs. Do not guess what you can read. For a Flutter app, look at pubspec.yaml, its flavors and the app folder, and run flutter devices to find the device or emulator id.',
    '2. Call the list_run_commands tool first, so you do not suggest a command the project already has.',
    '3. If a script is the cleanest way to run it, create the script in the project folder first, then make the run command call it.',
    `4. Call the propose_run_command tool once with a short label and one line of shell text. ${shellNotes(platform)}`,
    '5. The suggestion goes to the user to approve inside Runova. Do not run the project yourself. When the tool returns, tell the user in one sentence what you suggested and that it is waiting for their approval in Runova.',
  ].join('\n');
}

/** Requests a person can start from, so the dialog never opens on an empty box with no idea. */
export function runSetupExamples(platform: string): string[] {
  const script =
    platform === 'win32'
      ? 'Create a .bat file that runs the project, and a run command for it'
      : 'Create a .sh script that runs the project, and a run command for it';
  return [
    'Run the mobile app on the Android emulator',
    'Start the dev server',
    script,
    'Run the project with Docker Compose',
  ];
}
