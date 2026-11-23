import { Icon } from '@getpaseo/plugin/client/ui';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { EvidenceItem, LinkClass, Session } from '../shared/report-contracts.ts';
import { colors as palette } from '../shared/reporting-palette.ts';
import { formatInstant, providerNames } from './native-report-details.tsx';
import { useColors } from './native-ui.tsx';

export const linkLabels = {
  evidence: 'Evidence link',
  owner: 'Owner-confirmed',
  suggested: 'Suggested',
  unlinked: 'Unlinked',
  rejected: 'Marked incorrect',
} satisfies Record<LinkClass | EvidenceItem['effectiveClass'], string>;

const relationshipOf = (session: Session) =>
  session.relationshipLabel ??
  (session.kind === 'root'
    ? 'Root session'
    : session.kind === 'unknown'
      ? 'Unknown relationship'
      : session.paseo
        ? 'Paseo child agent'
        : 'Native subagent');

export const sessionName = (session: Session) =>
  session.named && session.nameLead ? session.nameLead : relationshipOf(session);

export function SessionIdentity({
  session,
  timezone,
  details = [],
  showMeta = true,
}: {
  session: Session;
  timezone: string;
  details?: string[];
  showMeta?: boolean;
}) {
  const named = session.named && session.nameLead;
  const subtitle = named
    ? [
        relationshipOf(session),
        session.kind !== 'child' && session.paseo && 'Paseo',
        session.paseo?.workspace,
        ...details,
      ]
    : ['No name recorded', ...details];
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <ReportText strong>{sessionName(session)}</ReportText>
      <ReportText muted size={12}>
        {subtitle.filter(Boolean).join(' · ')}
      </ReportText>
      <ReportText
        muted
        size={12}
        mono
        accessibilityLabel={`Session ID: ${session.providerSessionRef}`}
      >
        {session.providerSessionRef}
      </ReportText>
      {showMeta && (
        <ReportText muted size={12}>
          {providerNames[session.provider]}
          {session.model ? ` · ${session.model}` : ''}
          {' · Started '}
          {formatInstant(session.startedAt, timezone)}
        </ReportText>
      )}
    </View>
  );
}

const iconPaths = {
  right: 'm6 4 4 4-4 4',
  down: 'm4 6 4 4 4-4',
  external: 'M9 3h4v4M13 3 7 9m0-5H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9',
  check: 'm3 8 3 3 7-7',
  minus: 'M4 8h8',
  circle: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM5 8h6',
  alert: 'M8 2 1.5 13h13L8 2Zm0 4v3m0 2h.01',
  close: 'm5 5 6 6m0-6-6 6',
  dot: 'M8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  suggested: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z',
} as const;

export function ReportIcon({
  name,
  color = palette['text-muted'],
  size = 16,
}: {
  name: keyof typeof iconPaths;
  color?: string;
  size?: number;
}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${iconPaths[name]}" fill="${name === 'dot' ? color : 'none'}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${name === 'suggested' ? ' stroke-dasharray="1 2"' : ''}/></svg>`;
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Icon icon={{ svg }} size={size} />
    </View>
  );
}

export function ReportDisclosure({
  label,
  open,
  onPress,
  compact = false,
}: {
  label: string;
  open: boolean;
  onPress(): void;
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-expanded={open}
      onPress={onPress}
      hitSlop={compact ? 10 : 0}
      style={({ pressed }) => ({
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 12,
        backgroundColor: pressed ? palette['surface-sunken'] : 'transparent',
      })}
    >
      <ReportIcon name={open ? 'down' : 'right'} />
    </Pressable>
  );
}

export function ReportText({
  children,
  size = 13,
  muted,
  strong,
  right,
  mono,
  color,
  accessibilityLabel,
  singleLine,
}: {
  children: ReactNode;
  size?: number;
  muted?: boolean;
  strong?: boolean;
  right?: boolean;
  mono?: boolean;
  color?: string;
  accessibilityLabel?: string;
  singleLine?: boolean;
}) {
  return (
    <Text
      accessibilityLabel={accessibilityLabel}
      numberOfLines={singleLine ? 1 : undefined}
      selectable={mono}
      style={{
        color: color ?? palette[muted ? 'text-muted' : 'text'],
        fontSize: size,
        lineHeight: size + 4,
        fontWeight: strong ? '600' : '400',
        textAlign: right ? 'right' : undefined,
        fontFamily: mono ? 'monospace' : undefined,
        fontVariant: ['tabular-nums'],
      }}
    >
      {children}
    </Text>
  );
}

export function ReportLinkBadge({ kind }: { kind: keyof typeof linkLabels }) {
  const evidence = kind === 'evidence';
  const owner = kind === 'owner';
  const suggested = kind === 'suggested';
  const neutral = kind === 'unlinked';
  const color = evidence ? palette.action : owner ? palette.text : palette['text-muted'];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        borderRadius: 11,
        borderWidth: 1,
        borderStyle: suggested ? 'dashed' : 'solid',
        borderColor: owner
          ? palette.text
          : suggested
            ? palette['control-border']
            : kind === 'rejected'
              ? palette['border-strong']
              : 'transparent',
        backgroundColor: evidence
          ? palette['selection-surface']
          : neutral
            ? palette['surface-sunken']
            : palette.surface,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <ReportIcon
        name={
          evidence ? 'dot' : owner ? 'check' : suggested ? 'suggested' : neutral ? 'minus' : 'close'
        }
        size={12}
        color={color}
      />
      <ReportText size={12} strong color={color} singleLine>
        {linkLabels[kind]}
      </ReportText>
    </View>
  );
}

export type ReportColumn = { label: string; width: number; flex?: true; right?: true };

export function ReportTable({
  label,
  width,
  columns,
  children,
}: {
  label: string;
  width: number;
  columns: readonly ReportColumn[];
  children: ReactNode;
}) {
  const minimum = columns.reduce((sum, column) => sum + column.width, 0);
  return (
    <ScrollView
      horizontal
      scrollEnabled={width < minimum}
      focusable={width < minimum}
      accessibilityLabel={`${label}, scrolls sideways`}
    >
      <View role="table" accessibilityLabel={label} style={{ width: Math.max(width, minimum) }}>
        <ReportTableRow
          columns={columns}
          heading
          cells={columns.map((column) => (
            <ReportText key={column.label} size={12} muted strong right={column.right} singleLine>
              {column.label}
            </ReportText>
          ))}
        />
        {children}
      </View>
    </ScrollView>
  );
}

export function ReportTableRow({
  columns,
  cells,
  heading,
  fill,
}: {
  columns: readonly ReportColumn[];
  cells: ReactNode[];
  heading?: boolean;
  fill?: boolean;
}) {
  const colors = useColors();
  return (
    <View
      role="row"
      style={{
        flexDirection: 'row',
        borderTopWidth: heading ? 0 : 1,
        borderTopColor: colors.border,
        backgroundColor: fill ? colors.surface0 : undefined,
      }}
    >
      {columns.map((column, index) => (
        <View
          key={column.label}
          role={heading ? 'columnheader' : 'cell'}
          style={{
            flex: column.flex ? 1 : undefined,
            width: column.flex ? undefined : column.width,
            minWidth: column.width,
            paddingHorizontal: 10,
            paddingVertical: heading ? 8 : 10,
          }}
        >
          {cells[index]}
        </View>
      ))}
    </View>
  );
}
