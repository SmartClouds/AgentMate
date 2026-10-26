import type { CertificateInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useId, useState } from 'react';
import { Spinner, Trash2, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

/**
 * Asks before a certificate comes off a site, and whether to revoke it at the CA too (for a key
 * that may have leaked). The site goes back to plain HTTP once it is applied.
 */
export function RemoveCertificateDialog({
  certificate,
  domain,
  busy,
  onCancel,
  onConfirm,
}: {
  certificate: CertificateInfo | null;
  domain: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (revoke: boolean) => void;
}): React.JSX.Element {
  const revokeId = useId();
  const [revoke, setRevoke] = useState(false);
  const open = certificate !== null;

  useEffect(() => {
    if (open) setRevoke(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove the certificate from {domain}?</DialogTitle>
          <DialogDescription>
            The site is served over plain HTTP from then on, and Force HTTPS and HSTS are turned
            off.
          </DialogDescription>
        </DialogHeader>
        {certificate?.source === 'acme' && (
          <div className="flex items-start gap-2">
            <Checkbox
              id={revokeId}
              checked={revoke}
              onCheckedChange={(checked) => setRevoke(checked === true)}
            />
            <Label htmlFor={revokeId} className="text-sm font-normal leading-snug">
              Also revoke it at the CA. Do this if its private key may have leaked.
            </Label>
          </div>
        )}
        <p className="flex items-start gap-2 text-sm text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Visitors who were sent to HTTPS before may see errors until they come back over HTTP.
        </p>
        <DialogFooter>
          <Button type="button" variant="soft" disabled={busy} onClick={onCancel}>
            Keep it
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => onConfirm(revoke)}
          >
            {busy ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Remove the certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
