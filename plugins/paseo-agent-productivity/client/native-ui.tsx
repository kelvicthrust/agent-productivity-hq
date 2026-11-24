import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { ExternalLink, Icon } from '@getpaseo/plugin/client/ui';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors as palette } from '../shared/reporting-palette.ts';
import { dashboardDisplayFont, loadDashboardFont } from './web.ts';

type Colors = PluginScreenProps['theme']['colors'];
type DashboardLayout = { width: number; compact: boolean; rail: boolean; web: boolean };
const Theme = createContext<Colors | null>(null);
const Layout = createContext<DashboardLayout>({ width: 0, compact: false, rail: true, web: false });
export const useColors = () => useContext(Theme)!;
export const useDashboardLayout = () => useContext(Layout);

export function NativeAppearance({
  colors,
  layout,
  children,
}: {
  colors: Colors;
  layout: DashboardLayout;
  children: ReactNode;
}) {
  return (
    <Theme.Provider value={colors}>
      <Layout.Provider value={layout}>{children}</Layout.Provider>
    </Theme.Provider>
  );
}

export function NativePage({
  theme,
  layout,
  children,
  navigation,
  scrollKey,
}: Pick<PluginScreenProps, 'theme' | 'layout'> & {
  children: ReactNode;
  navigation?: ReactNode;
  scrollKey?: string;
}) {
  const [width, setWidth] = useState(0);
  const scroll = useRef<ScrollView>(null);
  const compact = width ? width < 720 : layout.compact;
  const rail = width ? width >= 1024 : !layout.compact;
  const web = layout.platform === 'web';
  useEffect(() => {
    if (web) loadDashboardFont();
  }, [web]);
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [scrollKey]);
  const colors = {
    ...theme.colors,
    surface0: palette.canvas,
    surface1: palette.surface,
    surface2: palette['surface-sunken'],
    foreground: palette.text,
    foregroundMuted: palette['text-muted'],
    accent: palette.action,
    accentForeground: palette['on-action'],
    border: palette.border,
    statusDanger: palette.danger,
    statusWarning: palette.warning,
  };
  return (
    <NativeAppearance colors={colors} layout={{ width, compact, rail, web }}>
      <View
        testID="agent-hq-app"
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        style={{
          flex: 1,
          flexDirection: navigation && rail ? 'row' : 'column',
          backgroundColor: colors.surface0,
        }}
      >
        {!compact && navigation}
        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: compact ? 16 : 24,
            paddingTop: navigation || compact ? undefined : 32,
            alignItems: 'center',
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <View style={{ width: '100%', maxWidth: navigation ? 1440 : 712, gap: 16 }}>
            {children}
          </View>
        </ScrollView>
        {compact && navigation}
      </View>
    </NativeAppearance>
  );
}

export function NativeText({
  children,
  tone = 'foreground',
  size = 14,
  heading = false,
  announce = false,
  selectable = false,
  style,
}: {
  children: ReactNode;
  tone?: keyof Colors;
  size?: number;
  heading?: boolean;
  announce?: boolean;
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  const colors = useColors();
  const { web } = useDashboardLayout();
  return (
    <Text
      accessibilityRole={heading ? 'header' : undefined}
      accessibilityLiveRegion={announce ? 'polite' : undefined}
      selectable={selectable}
      style={[
        {
          color: colors[tone],
          fontSize: size,
          lineHeight: size + (size <= 13 ? 4 : 6),
          fontWeight: heading ? (size < 20 ? '600' : '700') : '400',
          fontFamily: web && heading && size >= 16 ? dashboardDisplayFont : undefined,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export const cardShadow = {
  shadowColor: palette.text,
  shadowOffset: { width: 0, height: 3 },
  shadowOpacity: 0.07,
  shadowRadius: 6,
  elevation: 1,
} as const;

export function NativeProjectCredit() {
  const { compact } = useDashboardLayout();
  return (
    <View
      style={{
        marginTop: 16,
        borderTopWidth: 1,
        borderColor: palette.border,
        paddingTop: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <NativeText size={12} tone="foregroundMuted">
        Made with ❤️ by
      </NativeText>
      <ExternalLink href="https://github.com/kelvicthrust/agent-productivity-hq">
        <View style={{ minHeight: compact ? 44 : 28, justifyContent: 'center' }}>
          <NativeText size={12} style={{ textDecorationLine: 'underline' }}>
            kelvicthrust
          </NativeText>
        </View>
      </ExternalLink>
    </View>
  );
}

export function NativeCard({
  title,
  children,
  headingAccessory,
  style,
}: {
  title: string;
  children: ReactNode;
  headingAccessory?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        {
          ...cardShadow,
          backgroundColor: colors.surface1,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 14,
          padding: 16,
          gap: 10,
        },
        style,
      ]}
    >
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <NativeText heading size={16}>
          {title}
        </NativeText>
        {headingAccessory}
      </View>
      {children}
    </View>
  );
}

export function NativeRow({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, gap: 6 }}>
      {children}
    </View>
  );
}

export function NativeActions({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

export function NativeButton({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  expanded,
  primary,
  selected,
  variant = 'outline',
  selectionRole = 'checkbox',
  icon,
  iconOnly,
  style,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress(): void;
  disabled?: boolean;
  expanded?: boolean;
  primary?: boolean;
  selected?: boolean;
  variant?: 'outline' | 'ghost' | 'pill';
  selectionRole?: 'checkbox' | 'radio';
  icon?: string;
  iconOnly?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const { compact } = useDashboardLayout();
  const actionColor = primary
    ? colors.accentForeground
    : selected
      ? colors.accent
      : colors.foreground;
  return (
    <Pressable
      accessibilityRole={selected === undefined ? 'button' : selectionRole}
      accessibilityLabel={accessibilityLabel ?? (iconOnly ? label : undefined)}
      accessibilityState={{
        disabled: Boolean(disabled),
        expanded,
      }}
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          paddingHorizontal: iconOnly ? 0 : 12,
          paddingVertical: compact ? 6 : 3,
          minHeight: compact ? 44 : 30,
          minWidth: iconOnly ? 44 : undefined,
          maxWidth: '100%',
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          borderRadius: variant === 'pill' ? 999 : 8,
          borderWidth: 1,
          borderColor:
            primary || selected
              ? colors.accent
              : variant === 'outline'
                ? palette['border-strong']
                : 'transparent',
          backgroundColor: primary
            ? colors.accent
            : selected
              ? palette['selection-surface']
              : variant === 'outline'
                ? colors.surface1
                : 'transparent',
          opacity: disabled ? 0.55 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {icon && <Icon name={icon} size={14} color={actionColor} />}
      {!iconOnly && (
        <Text
          style={{
            color: actionColor,
            fontSize: 14,
            fontWeight: primary || selected ? '600' : '500',
            flexShrink: 1,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function NativeInput(props: TextInputProps & { ref?: Ref<TextInput> }) {
  const colors = useColors();
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor={colors.foregroundMuted}
      style={{
        backgroundColor: colors.surface0,
        color: colors.foreground,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 8,
        minHeight: 44,
        paddingHorizontal: 12,
        fontSize: 16,
      }}
      {...props}
    />
  );
}

export function NativeProblem({ message }: { message?: string }) {
  return message ? (
    <NativeText announce tone="statusDanger">
      {message}
    </NativeText>
  ) : null;
}
