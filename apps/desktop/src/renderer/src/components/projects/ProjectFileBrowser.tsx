import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MarkdownEditor } from '@/components/editor/MarkdownEditor';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { Code, File, FileText, Folder, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { isShortcutLetter } from '@/lib/shortcutKey';
import { cn } from '@/lib/utils';

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : path.slice(0, idx);
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'md':
      return 'markdown';
    case 'json':
      return 'json';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    default:
      return 'plaintext';
  }
}

export interface ProjectFileBrowserProps {
  rootPath: string;
  /** Bump to jump back to the root and refetch, e.g. after bootstrapping. */
  revision?: number;
}

export function ProjectFileBrowser({
  rootPath,
  revision = 0,
}: ProjectFileBrowserProps): React.JSX.Element {
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [markdownMode, setMarkdownMode] = useState(true);

  // Derived rather than a flag: Monaco echoes its own `setValue` back through
  // `onChange`, which would light up a flag on open without a real edit.
  const dirty = fileContent !== savedContent;

  // `currentPath` seeds from a prop, so it has to resync when the project
  // changes or when new files land underneath us.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the "files changed" signal that sends the browser back to the root
  useEffect(() => {
    setCurrentPath(rootPath);
  }, [rootPath, revision]);

  const dirQuery = useQuery({
    queryKey: ['project-dir', currentPath],
    queryFn: () => window.runova.fs.listDirectory(currentPath),
  });

  const entries = dirQuery.data ?? [];
  const relativePath = currentPath.slice(rootPath.length).replace(/^[\\/]/, '');

  async function openFile(path: string): Promise<void> {
    if (path === selectedFile) return;
    // Leaving an edited file behind silently would lose the edits, so make
    // walking away a deliberate choice.
    if (
      dirty &&
      !window.confirm('This file has unsaved changes. Discard them and open the other file?')
    ) {
      return;
    }
    try {
      const content = await window.runova.fs.readFile(path);
      setSelectedFile(path);
      setFileContent(content);
      setSavedContent(content);
    } catch (error) {
      toast.error(`Could not open file: ${(error as Error).message}`);
    }
  }

  async function saveFile(): Promise<void> {
    if (!selectedFile) return;
    try {
      await window.runova.fs.writeFile(selectedFile, fileContent);
      setSavedContent(fileContent);
      toast.success('File saved.');
    } catch (error) {
      toast.error(`Could not save file: ${(error as Error).message}`);
    }
  }

  return (
    <div className="flex gap-4">
      <div className="w-56 shrink-0 space-y-0.5">
        <div className="mb-1 flex items-center justify-between gap-1">
          <SimpleTooltip label={currentPath}>
            <span className="truncate text-xs font-medium">{relativePath || '/'}</span>
          </SimpleTooltip>
          <SimpleTooltip label="Refresh">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh"
              className="shrink-0"
              onClick={() => void dirQuery.refetch()}
            >
              <RefreshCw className={cn(dirQuery.isFetching && 'animate-spin')} />
            </Button>
          </SimpleTooltip>
        </div>
        {currentPath !== rootPath && (
          <button
            className="w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setCurrentPath(parentOf(currentPath))}
          >
            .. up
          </button>
        )}
        {dirQuery.isPending && <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>}
        {dirQuery.isError && (
          <div className="space-y-1 px-2 py-1">
            <p className="text-xs text-destructive">
              {(dirQuery.error as Error).message || 'Could not read this folder.'}
            </p>
            <button
              className="rounded text-xs text-muted-foreground underline hover:bg-accent"
              onClick={() => void dirQuery.refetch()}
            >
              Try again
            </button>
          </div>
        )}
        {dirQuery.isSuccess && entries.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">This folder is empty.</p>
        )}
        {entries.map((entry) => (
          <button
            key={entry.path}
            onClick={() =>
              entry.isDirectory ? setCurrentPath(entry.path) : void openFile(entry.path)
            }
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-accent',
              selectedFile === entry.path && 'bg-accent',
            )}
          >
            {entry.isDirectory ? (
              <Folder className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <File className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{entry.name}</span>
          </button>
        ))}
      </div>
      <div
        className="min-w-0 flex-1"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && isShortcutLetter(event, 's')) {
            event.preventDefault();
            void saveFile();
          }
        }}
      >
        {selectedFile ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <SimpleTooltip label={dirty ? `${selectedFile} (unsaved changes)` : selectedFile}>
                <span className="truncate text-xs text-muted-foreground">
                  {selectedFile}
                  {dirty && <span className="ml-1 text-foreground">•</span>}
                </span>
              </SimpleTooltip>
              {isMarkdown(selectedFile) && (
                <div className="ml-auto flex items-center gap-0.5 rounded-md border border-border p-0.5">
                  <SimpleTooltip label="Rich markdown editor">
                    <button
                      type="button"
                      onClick={() => setMarkdownMode(true)}
                      className={cn(
                        'flex h-6 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-accent',
                        markdownMode && 'bg-accent text-foreground',
                      )}
                    >
                      <FileText className="h-3 w-3" /> Markdown
                    </button>
                  </SimpleTooltip>
                  <SimpleTooltip label="Plain text editor">
                    <button
                      type="button"
                      onClick={() => setMarkdownMode(false)}
                      className={cn(
                        'flex h-6 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-accent',
                        !markdownMode && 'bg-accent text-foreground',
                      )}
                    >
                      <Code className="h-3 w-3" /> Text
                    </button>
                  </SimpleTooltip>
                </div>
              )}
              <Button
                size="sm"
                className={cn(!isMarkdown(selectedFile) && 'ml-auto')}
                disabled={!dirty}
                onClick={() => void saveFile()}
              >
                Save
              </Button>
            </div>
            {isMarkdown(selectedFile) && markdownMode ? (
              <MarkdownEditor
                // Remount per file so the editor never carries one file's
                // scroll position or caret into the next.
                key={selectedFile}
                value={fileContent}
                onChange={setFileContent}
                onSave={() => void saveFile()}
              />
            ) : (
              <MonacoEditor
                // Monaco takes its language at creation time, so a new file
                // needs a new instance to be highlighted as itself.
                key={selectedFile}
                value={fileContent}
                language={languageFor(selectedFile)}
                onChange={setFileContent}
                className="min-h-[420px]"
              />
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Select a file to edit.</p>
        )}
      </div>
    </div>
  );
}
