import type { RecaptchaKeyType } from '@shared/deployRecaptchaTypes';
import { SNIPPET_LANGUAGES, type SnippetLanguage, snippetFor } from '@shared/recaptcha/snippets';
import { useId, useState } from 'react';
import { PillTabs } from '@/components/pageKit';
import { CopyButton } from './keyParts';

/** The code to paste for a key: the page side with the site key in it, and the server check. */
export function IntegrationSnippets({
  siteKey,
  type,
}: {
  siteKey: string;
  type: RecaptchaKeyType;
}): React.JSX.Element {
  const id = useId();
  const [language, setLanguage] = useState<SnippetLanguage>('html');
  const code = snippetFor(language, { siteKey, type });
  const serverSide = language === 'php' || language === 'node';

  return (
    <div className="space-y-2">
      <PillTabs
        id={`${id}-language`}
        label="Language"
        kind="toggle"
        size="xs"
        items={SNIPPET_LANGUAGES.map((one) => ({ value: one.id, label: one.label }))}
        value={language}
        onChange={setLanguage}
      />
      <div className="relative">
        <pre
          data-testid="snippet"
          className="max-h-64 overflow-auto rounded-xl bg-foreground/[0.05] p-3 pr-10 font-mono text-[11.5px] leading-relaxed text-foreground ring-1 ring-inset ring-foreground/[0.08]"
        >
          {code}
        </pre>
        <CopyButton text={code} label="Copy code" className="absolute right-1.5 top-1.5" />
      </div>
      <p className="text-xs text-muted-foreground">
        {serverSide
          ? 'This reads the secret from RECAPTCHA_SECRET. Set that on your server, never in the page.'
          : 'Put this in the page with your form. Then check the token on your server with the PHP or Node.js code.'}
      </p>
    </div>
  );
}
