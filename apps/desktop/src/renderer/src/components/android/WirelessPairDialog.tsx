import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Pairing a phone over Wi-Fi.
 *
 * The thing everyone gets wrong is that the pairing port and the connect port are different: the
 * phone shows a random one-time port for pairing, then adb connects on 5555. So this walks the
 * two steps in order and pre-fills the second with the right port, and errors land inline under
 * the field rather than in a toast, because the phone is in the user's other hand.
 */

const CONNECT_PORT = 5555;

interface WirelessPairDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WirelessPairDialog({
  open,
  onOpenChange,
}: WirelessPairDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'pair' | 'connect'>('pair');
  const [pairAddress, setPairAddress] = useState('');
  const [code, setCode] = useState('');
  const [connectAddress, setConnectAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    onOpenChange(false);
    setStep('pair');
    setCode('');
    setError(null);
  };

  const pair = useMutation({
    mutationFn: () => window.runova.android.pair(pairAddress, code),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.message ?? 'Pairing failed.');
        return;
      }
      setError(null);
      // Same host, different port. Pre-filling it is the whole reason this is two steps.
      const host = pairAddress.trim().split(':')[0];
      setConnectAddress(`${host}:${CONNECT_PORT}`);
      setStep('connect');
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const connect = useMutation({
    mutationFn: () => window.runova.android.connect(connectAddress),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.message ?? 'Could not connect.');
        return;
      }
      toast.success('Device connected.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.androidSnapshot });
      close();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === 'pair' ? 'Pair over Wi-Fi' : 'Connect'}</DialogTitle>
          <DialogDescription>
            {step === 'pair'
              ? 'On the phone: Settings, Developer options, Wireless debugging, then "Pair device with pairing code".'
              : 'Paired. Now connect to the phone on its normal debugging port.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'pair' ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pair-address">Address and port</Label>
              <Input
                id="pair-address"
                value={pairAddress}
                placeholder="192.168.1.20:37105"
                onChange={(event) => setPairAddress(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The phone shows this on the pairing screen. It is not the same port you connect on.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pair-code">Pairing code</Label>
              <Input
                id="pair-code"
                value={code}
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="connect-address">Address and port</Label>
            <Input
              id="connect-address"
              value={connectAddress}
              placeholder={`192.168.1.20:${CONNECT_PORT}`}
              onChange={(event) => setConnectAddress(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Wireless debugging shows this one at the top of its own screen.
            </p>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          {step === 'pair' ? (
            <Button disabled={pair.isPending} onClick={() => pair.mutate()}>
              {pair.isPending ? 'Pairing' : 'Pair'}
            </Button>
          ) : (
            <Button disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? 'Connecting' : 'Connect'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
