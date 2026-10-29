import type { StackDetails } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useState } from 'react';
import { ArrowRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { initialSource } from './NewAppWizard';
import { ComposeFilePicker, EnvironmentPicker, useComposeFiles } from './wizard/SourcePickers';
import type { WizardSource } from './wizard/types';

/**
 * Changes which compose file, environment and env files an app deploys from. The project stays
 * the same. Nothing goes to the server here: the server learns a source with a revision, so
 * Continue hands the pick to the Deploy again wizard, which checks it before it ships.
 */

const sameFiles = (a: string[] | null, b: string[] | null) =>
  JSON.stringify(a) === JSON.stringify(b);

export function EditSourceDialog({
  serverId,
  details,
  onClose,
  onContinue,
}: {
  serverId: string;
  details: StackDetails;
  onClose: () => void;
  onContinue: (source: WizardSource) => void;
}): React.JSX.Element {
  const [start] = useState(() => initialSource(serverId, details));
  const [source, setSource] = useState(start);
  const discovery = useComposeFiles(source.projectId);
  const compose = discovery.data?.files.find((file) => file.path === source.composePath);
  const envFileIds = source.environmentId ? source.envFileIds : null;

  const changed =
    source.composePath !== start.composePath ||
    source.environmentId !== start.environmentId ||
    !sameFiles(envFileIds, start.envFileIds);
  const filesPicked = envFileIds === null || envFileIds.length > 0;
  const readable = compose !== undefined && compose.error === undefined;
  const ok = changed && filesPicked && readable;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Change what {details.stack.name} deploys</DialogTitle>
          <DialogDescription>
            From {source.projectName || 'its project'}. The change goes out as a new revision once
            you deploy it.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 max-h-[60vh] space-y-5 overflow-y-auto px-1 py-1">
          <ComposeFilePicker
            projectId={source.projectId}
            value={source.composePath}
            onChange={(composePath) => setSource((current) => ({ ...current, composePath }))}
          />
          <EnvironmentPicker
            projectId={source.projectId}
            environmentId={source.environmentId}
            envFileIds={source.envFileIds}
            onChange={(next) => setSource((current) => ({ ...current, ...next }))}
          />
        </div>
        <DialogFooter className="items-center pt-3">
          {!changed && (
            <p className="mr-auto text-xs text-muted-foreground">Pick another file to continue.</p>
          )}
          <Button type="button" variant="soft" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!ok}
            onClick={() => onContinue({ ...source, envFileIds })}
          >
            Continue <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
