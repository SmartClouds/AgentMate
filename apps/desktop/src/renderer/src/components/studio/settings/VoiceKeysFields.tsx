import type { VoiceEngineView } from '@agentmat/studio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { studioAudioClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Chip,
  Input,
  Label,
  Lock,
  SecretInput,
  Skeleton,
  toast,
  VaultUnlockDialog,
} from '../kit';
import { studioKeys } from '../queryKeys';

type KeyInput = { engine: 'elevenlabs' | 'azure'; key: string | null; region?: string };

function status(engine: VoiceEngineView | undefined): React.JSX.Element {
  if (engine?.locked) return <Chip tone="warning">Locked in the vault</Chip>;
  if (engine && !engine.problem) return <Chip tone="success">Saved</Chip>;
  return <Chip tone="neutral">Not set</Chip>;
}

/**
 * Keys for the voice engines that AgentMate has no setting for elsewhere: ElevenLabs, and Azure
 * Speech with its region. They are sealed with the vault, like server passwords. OpenAI and Gemini
 * use the keys in Settings > AI.
 */
export function VoiceKeysFields(): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const engines = useQuery({
    queryKey: studioKeys.voiceEngines,
    queryFn: () => studioAudioClient().engines(),
  });
  const [eleven, setEleven] = useState('');
  const [azure, setAzure] = useState('');
  const [region, setRegion] = useState('');
  const [unlocking, setUnlocking] = useState(false);

  const save = useMutation({
    mutationFn: (input: KeyInput) => studioAudioClient().setKey(input),
    onSuccess: (next, input) => {
      queryClient.setQueryData(studioKeys.voiceEngines, next);
      void queryClient.invalidateQueries({ queryKey: ['studio', 'voices'] });
      if (input.engine === 'elevenlabs') setEleven('');
      else setAzure('');
      toast.success(input.key ? 'Key saved.' : 'Key removed.');
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  if (!engines.data) return <Skeleton className="h-32 w-full" />;
  const byId = (engineId: string) => engines.data.find((e) => e.id === engineId);
  const locked = engines.data.some((e) => e.locked);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">Voice engine keys</p>
        <p className="text-xs text-muted-foreground">
          Sealed with the vault on this computer. OpenAI and Gemini voices use the keys in Settings
          &gt; AI.
        </p>
      </div>
      {locked && (
        <Button size="sm" variant="soft" onClick={() => setUnlocking(true)}>
          <Lock /> Unlock the vault
        </Button>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-eleven`}>ElevenLabs key</Label>
          {status(byId('elevenlabs'))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SecretInput
            id={`${id}-eleven`}
            className="h-8 w-80"
            value={eleven}
            onChange={setEleven}
            placeholder="Paste a new key"
          />
          <Button
            size="sm"
            disabled={!eleven.trim() || save.isPending}
            onClick={() => save.mutate({ engine: 'elevenlabs', key: eleven })}
          >
            Save
          </Button>
          {!byId('elevenlabs')?.problem && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => save.mutate({ engine: 'elevenlabs', key: null })}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-azure`}>Azure Speech key and region</Label>
          {status(byId('azure'))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SecretInput
            id={`${id}-azure`}
            className="h-8 w-64"
            value={azure}
            onChange={setAzure}
            placeholder="Paste a new key"
          />
          <Input
            aria-label="Azure region"
            className="h-8 w-36"
            value={region}
            placeholder="westeurope"
            onChange={(event) => setRegion(event.target.value.trim().toLowerCase())}
          />
          <Button
            size="sm"
            disabled={!azure.trim() || !region || save.isPending}
            onClick={() => save.mutate({ engine: 'azure', key: azure, region })}
          >
            Save
          </Button>
          {!byId('azure')?.problem && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => save.mutate({ engine: 'azure', key: null })}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      <VaultUnlockDialog
        open={unlocking}
        onOpenChange={setUnlocking}
        mode="unlock"
        onUnlocked={() => {
          setUnlocking(false);
          void queryClient.invalidateQueries({ queryKey: studioKeys.voiceEngines });
        }}
      />
    </div>
  );
}
