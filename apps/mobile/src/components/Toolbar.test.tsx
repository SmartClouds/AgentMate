import { describe, expect, it, jest } from '@jest/globals';
import type { RemoteInputEvent } from '@runova/protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Toolbar } from './Toolbar';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderToolbar(live = true) {
  const onInput = jest.fn<(event: RemoteInputEvent) => void>();
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <Toolbar live={live} onInput={onInput} />
    </SafeAreaProvider>,
  );
  return onInput;
}

/** The offscreen TextInput that borrows the system keyboard. */
function hiddenInput(value = '') {
  return screen.getByDisplayValue(value);
}

describe('Toolbar', () => {
  it('sends a full press and release for each special key', async () => {
    // The host replays these as real key events, so a down without an up would
    // leave a modifier or arrow stuck on the desktop.
    const onInput = await renderToolbar();

    await fireEvent.press(screen.getByText('Esc'));
    expect(onInput.mock.calls).toEqual([
      [{ k: 'key', code: 'Escape', down: true }],
      [{ k: 'key', code: 'Escape', down: false }],
    ]);
  });

  it.each([
    ['Tab', 'Tab'],
    ['⌫', 'Backspace'],
    ['↵', 'Enter'],
    ['←', 'ArrowLeft'],
    ['↑', 'ArrowUp'],
    ['↓', 'ArrowDown'],
    ['→', 'ArrowRight'],
  ])('maps the %s button to %s', async (label, code) => {
    const onInput = await renderToolbar();
    await fireEvent.press(screen.getByText(label));
    expect(onInput).toHaveBeenCalledWith({ k: 'key', code, down: true });
    expect(onInput).toHaveBeenCalledWith({ k: 'key', code, down: false });
  });

  it('sends nothing while the session is not live', async () => {
    const onInput = await renderToolbar(false);
    await fireEvent.press(screen.getByText('Esc'));
    await fireEvent.changeText(hiddenInput(), 'hello');
    expect(onInput).not.toHaveBeenCalled();
  });

  it('forwards typed characters as text, not as key codes', async () => {
    // The soft keyboard reports no key codes, so literal typing has to travel
    // as text for the host to inject it as Unicode.
    const onInput = await renderToolbar();

    await fireEvent.changeText(hiddenInput(), 'h');
    expect(onInput).toHaveBeenLastCalledWith({ k: 'text', text: 'h' });

    await fireEvent.changeText(hiddenInput('h'), 'hi');
    expect(onInput).toHaveBeenLastCalledWith({ k: 'text', text: 'i' });
  });

  it('sends a pasted run in one text event', async () => {
    const onInput = await renderToolbar();
    await fireEvent.changeText(hiddenInput(), 'pasted text');
    expect(onInput.mock.calls).toEqual([[{ k: 'text', text: 'pasted text' }]]);
  });

  it('turns deletions into one Backspace per character', async () => {
    const onInput = await renderToolbar();
    await fireEvent.changeText(hiddenInput(), 'abc');
    onInput.mockClear();

    await fireEvent.changeText(hiddenInput('abc'), 'a');
    expect(onInput.mock.calls).toEqual([
      [{ k: 'key', code: 'Backspace', down: true }],
      [{ k: 'key', code: 'Backspace', down: false }],
      [{ k: 'key', code: 'Backspace', down: true }],
      [{ k: 'key', code: 'Backspace', down: false }],
    ]);
  });

  it('sends Enter when the keyboard return key is used', async () => {
    const onInput = await renderToolbar();
    await fireEvent(hiddenInput(), 'submitEditing');
    expect(onInput.mock.calls).toEqual([
      [{ k: 'key', code: 'Enter', down: true }],
      [{ k: 'key', code: 'Enter', down: false }],
    ]);
  });

  it('starts a fresh buffer after the keyboard closes', async () => {
    // The buffer only exists to diff against; keeping it across a dismissal
    // would make the next character look like a deletion.
    const onInput = await renderToolbar();
    await fireEvent(hiddenInput(), 'focus');
    await fireEvent.changeText(hiddenInput(), 'abc');
    await fireEvent(hiddenInput('abc'), 'blur');
    onInput.mockClear();

    await fireEvent.changeText(hiddenInput(), 'x');
    expect(onInput.mock.calls).toEqual([[{ k: 'text', text: 'x' }]]);
  });

  it('does not send input when the keyboard button is tapped', async () => {
    const onInput = await renderToolbar();
    await fireEvent.press(screen.getByText('⌨'));
    expect(onInput).not.toHaveBeenCalled();
  });

  it('toggles the keyboard off again on a second tap', async () => {
    // The same button opens and dismisses the keyboard, so it has to know which
    // state it is in rather than always asking for focus.
    const onInput = await renderToolbar();
    await fireEvent.press(screen.getByText('⌨'));
    await fireEvent(hiddenInput(), 'focus');
    await fireEvent.press(screen.getByText('⌨'));
    await fireEvent(hiddenInput(), 'blur');
    expect(onInput).not.toHaveBeenCalled();
  });
});
