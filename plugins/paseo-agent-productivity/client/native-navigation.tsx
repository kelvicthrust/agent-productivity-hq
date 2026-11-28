import { Icon } from '@getpaseo/plugin/client/ui';
import { Pressable, ScrollView, View } from 'react-native';
import { colors as palette } from '../shared/reporting-palette.ts';
import type { DashboardPage } from './native-reporting.tsx';
import { NativeText, useDashboardLayout } from './native-ui.tsx';

const pages: ReadonlyArray<[DashboardPage, string, string, string?]> = [
  ['overview', 'Overview', 'LayoutGrid'],
  ['trends', 'Trends', 'TrendingUp'],
  ['delivery', 'Delivery', 'GitMerge'],
  ['usage', 'Usage', 'Layers'],
  ['hq', 'HQ', 'House'],
  ['sources', 'Sources & repos', 'Plug', 'Sources'],
];

export function NativeNavigation({
  current,
  issues = 0,
  navigate,
}: {
  current: DashboardPage;
  issues?: number;
  navigate(page: DashboardPage): void;
}) {
  const { compact, rail } = useDashboardLayout();
  const entries = compact ? pages.filter(([page]) => page !== 'hq') : pages;
  const items = entries.map(([page, name, icon, shortName]) => {
    const active = current === page || (current === 'work-review' && page === 'delivery');
    const showIssues = page === 'sources' && issues > 0;
    const label = compact ? (shortName ?? name) : name;
    return (
      <Pressable
        key={page}
        accessibilityRole="tab"
        accessibilityHint={showIssues ? 'Some sources need attention' : undefined}
        aria-selected={active}
        onPress={() => navigate(page)}
        style={({ pressed }) => ({
          minHeight: compact ? 49 : rail ? 38 : 34,
          justifyContent: compact ? 'center' : 'flex-start',
          alignItems: 'center',
          flexDirection: compact ? 'column' : 'row',
          flexGrow: compact ? 1 : 0,
          gap: compact ? 2 : 10,
          minWidth: 0,
          paddingHorizontal: compact ? 3 : 12,
          borderRadius: 999,
          backgroundColor: active
            ? palette['selection-surface']
            : pressed
              ? palette['surface-sunken']
              : 'transparent',
        })}
      >
        <Icon name={icon} size={16} color={active ? palette.action : palette['text-muted']} />
        <NativeText
          size={compact ? 12 : 13}
          tone={active ? 'foreground' : 'foregroundMuted'}
          style={{ fontWeight: active ? '600' : '500' }}
        >
          {label}
        </NativeText>
        {showIssues && (
          <View
            style={{
              position: compact ? 'absolute' : 'relative',
              top: compact ? 3 : undefined,
              right: compact ? 1 : undefined,
              marginStart: compact ? 0 : 'auto',
              minWidth: 19,
              alignItems: 'center',
              borderRadius: 999,
              backgroundColor: palette['warning-surface'],
            }}
          >
            <NativeText size={11} tone="statusWarning" style={{ fontWeight: '600' }}>
              {issues}
            </NativeText>
          </View>
        )}
      </Pressable>
    );
  });

  if (!compact && !rail) {
    return (
      <ScrollView
        horizontal
        accessibilityRole="tablist"
        accessibilityLabel="Agent HQ pages"
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8, gap: 4 }}
      >
        {items}
      </ScrollView>
    );
  }
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Agent HQ pages"
      style={{
        backgroundColor: compact ? palette.surface : palette.canvas,
        flexDirection: compact ? 'row' : 'column',
        borderTopWidth: compact ? 1 : 0,
        borderColor: palette.border,
        paddingHorizontal: compact ? 4 : 12,
        paddingTop: compact ? 4 : 12,
        paddingBottom: compact ? 4 : 16,
        gap: compact ? 0 : 4,
        width: compact ? '100%' : 220,
      }}
    >
      {items}
    </View>
  );
}
