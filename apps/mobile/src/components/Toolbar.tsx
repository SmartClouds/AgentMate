import type { RemoteInputEvent } from '@runova/protocol';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '../theme';

interface ToolbarProps {
  live: boolean;
  onInput: (event: RemoteInputEvent) => void;
}

interface KeyDef {
  label: string;
  code: string;
}

const KEYS: KeyDef[] = [
  { label: 'Esc', code: 'Escape' },
  { label: 'Tab', code: 'Tab' },
  { label: '⌫', code: 'Backspace' },
  { label: '↵', code: 'Enter' },
  { label: '←', code: 'ArrowLeft' },
  { label: '↑', code: 'ArrowUp' },
  { label: '↓', code: 'ArrowDown' },
  { label: '→', code: 'ArrowRight' },
];

/**
 * Bottom input bar: a hidden TextInput brings up the system keyboard and its
 * `onChangeText` diff is forwarded as 'text' events, plus a row of keys the
 * soft keyboard can't produce (Esc, arrows, ...) sent as 'key' events.
 * Together they cover what apps/desktop's RemoteScreen.tsx gets for free
 * from real onKeyDown/onKeyUp DOM events.
 */
export function Toolbar({ live, onInput }: ToolbarProps): React.JSX.Element {
  const inputRef = useRef<TextInput>(null);
  const [buffer, setBuffer] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  // Keep the key row above the Android navigation bar / iOS home indicator.
  const insets = useSafeAreaInsets();

  const tapKey = (code: string) => {
    if (!live) return;
    onInput({ k: 'key', code, down: true });
    onInput({ k: 'key', code, down: false });
  };

  const onChangeText = (next: string) => {
    if (!live) return;
    if (next.length > buffer.length) {
      onInput({ k: 'text', text: next.slice(buffer.length) });
    } else if (next.length < buffer.length) {
      const deleted = buffer.length - next.length;
      for (let i = 0; i < deleted; i++) tapKey('Backspace');
    }
    setBuffer(next);
  };

  return (
    <View style={[styles.wrap, { paddingBottom: insets.bottom }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        <Pressable
          style={[styles.key, keyboardOpen && styles.keyActive]}
          onPress={() => {
            if (keyboardOpen) {
              inputRef.current?.blur();
            } else {
              inputRef.current?.focus();
            }
          }}
        >
          <Text style={styles.keyText}>⌨</Text>
        </Pressable>
        {KEYS.map((k) => (
          <Pressable
            key={k.code}
            style={styles.key}
            onPress={() => tapKey(k.code)}
            disabled={!live}
          >
            <Text style={styles.keyText}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <TextInput
        ref={inputRef}
        value={buffer}
        onChangeText={onChangeText}
        onSubmitEditing={() => tapKey('Enter')}
        onFocus={() => setKeyboardOpen(true)}
        onBlur={() => {
          setKeyboardOpen(false);
          setBuffer('');
        }}
        autoCorrect={false}
        autoCapitalize="none"
        style={styles.hiddenInput}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  row: {
    paddingHorizontal: spacing(2),
    paddingVertical: spacing(2),
    gap: spacing(2),
  },
  key: {
    minWidth: 44,
    height: 40,
    paddingHorizontal: spacing(3),
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyActive: {
    backgroundColor: colors.primary,
  },
  keyText: {
    color: colors.foreground,
    fontSize: 16,
    fontWeight: '600',
  },
  hiddenInput: {
    position: 'absolute',
    height: 1,
    width: 1,
    opacity: 0,
  },
});
