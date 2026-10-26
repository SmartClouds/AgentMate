import { type DraftBody, emptyBody } from '@runova/core';
import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

vi.mock('@/components/editor/MonacoEditor', () => ({
  MonacoEditor: ({
    value,
    language,
    onChange,
  }: {
    value: string;
    language: string;
    onChange?: (v: string) => void;
  }) => (
    <textarea
      aria-label="Raw body"
      data-language={language}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const { BodyEditor } = await import('./BodyEditor');

function Harness({ initial, onBody }: { initial?: DraftBody; onBody?: (b: DraftBody) => void }) {
  const [body, setBody] = useState(initial ?? emptyBody());
  return (
    <BodyEditor
      body={body}
      onChange={(next) => {
        setBody(next);
        onBody?.(next);
      }}
    />
  );
}

describe('BodyEditor', () => {
  it('says there is no body until a type is picked', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole('radio', { name: 'none' })).toBeChecked();
    expect(screen.getByText(/this request does not have a body/i)).toBeInTheDocument();
  });

  it('edits a raw body in the chosen language', async () => {
    const onBody = vi.fn();
    const { user } = renderWithProviders(<Harness onBody={onBody} />);

    await user.click(screen.getByRole('radio', { name: 'raw' }));
    expect(screen.getByLabelText('Raw body')).toHaveAttribute('data-language', 'json');

    await user.click(screen.getByRole('button', { name: /body language/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'XML' }));
    expect(onBody).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'raw', language: 'xml' }),
    );
    expect(screen.getByLabelText('Raw body')).toHaveAttribute('data-language', 'xml');
  });

  it('keeps what was typed for each type when switching between them', async () => {
    const { user } = renderWithProviders(
      <Harness initial={{ ...emptyBody(), mode: 'raw', raw: '{"a":1}' }} />,
    );
    await user.click(screen.getByRole('radio', { name: 'x-www-form-urlencoded' }));
    await user.type(screen.getAllByRole('textbox', { name: 'Form fields key' })[0]!, 'k');
    await user.click(screen.getByRole('radio', { name: 'raw' }));
    expect(screen.getByLabelText('Raw body')).toHaveValue('{"a":1}');
    await user.click(screen.getByRole('radio', { name: 'x-www-form-urlencoded' }));
    expect(screen.getByDisplayValue('k')).toBeInTheDocument();
  });

  it('beautifies JSON', async () => {
    const onBody = vi.fn();
    const { user } = renderWithProviders(
      <Harness initial={{ ...emptyBody(), mode: 'raw', raw: '{"a":[1,2]}' }} onBody={onBody} />,
    );
    await user.click(screen.getByRole('button', { name: /beautify/i }));
    expect(onBody).toHaveBeenLastCalledWith(
      expect.objectContaining({ raw: '{\n  "a": [\n    1,\n    2\n  ]\n}' }),
    );
  });
});
