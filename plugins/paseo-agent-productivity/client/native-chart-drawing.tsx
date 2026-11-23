import { Icon } from '@getpaseo/plugin/client/ui';
import { useId, useMemo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { BucketShape, ChartLayout, Rect } from '../shared/reporting-chart-layout.ts';
import { colors } from '../shared/reporting-palette.ts';
import { providerColors } from './native-report-details.tsx';
import { useDashboardLayout } from './native-ui.tsx';
import { dashboardDisplayFont } from './web.ts';

/** Paseo icons occupy a square. Tall and wide plots are clipped to their actual height. */
export function ReportSvg({
  width,
  height,
  layers,
}: {
  width: number;
  height: number;
  layers: readonly string[];
}) {
  const size = Math.max(width, height);
  return (
    <View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', top: 0, left: 0, width, height, overflow: 'hidden' }}
    >
      {layers.map((layer, i) => (
        <View key={i} style={{ position: 'absolute', top: 0, left: 0 }}>
          <Icon
            icon={{
              svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${layer}</svg>`,
            }}
            size={size}
          />
        </View>
      ))}
    </View>
  );
}

export function PlotLabel({
  x,
  y,
  width,
  align = 'left',
  children,
}: {
  x: number;
  y: number;
  width: number;
  align?: 'left' | 'center' | 'right';
  children: ReactNode;
}) {
  return (
    <Text
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no"
      numberOfLines={1}
      style={{
        position: 'absolute',
        left: x,
        top: y - 12,
        width,
        textAlign: align,
        fontSize: 11,
        lineHeight: 14,
        color: colors['text-muted'],
      }}
    >
      {children}
    </Text>
  );
}

function PlotPanelTitle({ y, title, unit }: { y: number; title: string; unit: string }) {
  const { web } = useDashboardLayout();
  return (
    <View
      aria-hidden
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: y - 12,
        flexDirection: 'row',
        alignItems: 'baseline',
        columnGap: 8,
      }}
    >
      <Text
        style={{
          color: colors.text,
          lineHeight: 14,
          fontSize: 12,
          fontWeight: '700',
          fontFamily: web ? dashboardDisplayFont : undefined,
        }}
      >
        {title}
      </Text>
      <Text style={{ color: colors['text-muted'], lineHeight: 14, fontSize: 11 }}>{unit}</Text>
    </View>
  );
}

const pattern = (id: string, type: 'claude' | 'coverage') =>
  type === 'claude'
    ? `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="${providerColors.claude}"/><rect width="1.4" height="5" fill="${colors['hatch-light']}"/></pattern>`
    : `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="${colors['surface-sunken']}"/><circle cx="2.5" cy="2.5" r="1.2" fill="${colors['coverage-hatch']}"/></pattern>`;

type Swatch =
  'delivery' | 'codex' | 'claude' | 'unavailable' | 'zero' | 'complete' | 'partial' | 'none';

export function ChartSwatch({ kind }: { kind: Swatch }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const unavailable = `${id}-coverage`;
  const claude = `${id}-claude`;
  const width = 14;
  const height = 10;
  const hatch = `url(#${unavailable})`;
  const stripe = `url(#${claude})`;
  const full = { x: 0, y: 0, width, height };
  const rail = { x: 0, y: 3, width, height: 5 };
  const marks: Record<Swatch, string> = {
    delivery: box(full, colors['series-delivery'], ' rx="1"'),
    codex: box(full, providerColors.codex, ' rx="1"'),
    claude: `<defs>${pattern(claude, 'claude')}</defs>${box(full, stripe, ' rx="1"')}`,
    unavailable: `<defs>${pattern(unavailable, 'coverage')}</defs>${box(full, hatch)}`,
    zero: box({ ...full, y: 8, height: 1.5 }, colors['text-muted']),
    complete: box(rail, colors['border-strong']),
    partial: `<defs>${pattern(unavailable, 'coverage')}</defs>${box(rail, hatch, ` stroke="${colors['coverage-hatch']}" stroke-width="0.75"`)}`,
    none: box(
      { ...rail, x: 0.5, width: 13 },
      colors.surface,
      ` stroke="${colors['border-strong']}"`,
    ),
  };
  return (
    <View style={{ width, height }}>
      <ReportSvg width={width} height={height} layers={[marks[kind]]} />
    </View>
  );
}

export function ClaudeModelFill({ width }: { width: number }) {
  const id = `model-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <ReportSvg
      width={width}
      height={10}
      layers={[
        `<defs>${pattern(id, 'claude')}</defs>${box({ x: 0, y: 0, width, height: 10 }, `url(#${id})`, ' rx="5"')}`,
      ]}
    />
  );
}

function box(rect: Rect, fill: string, extra = '') {
  return `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="${fill}"${extra}/>`;
}

function marks({ delivery, usage, rail }: BucketShape, hatch: string, claude: string): string {
  const zero = colors['text-muted'];
  let markup = '';
  if (delivery.kind !== 'empty') {
    markup +=
      delivery.kind === 'zero'
        ? box(delivery.rect, zero)
        : box(delivery.rect, colors['series-delivery'], ` rx="${delivery.radius}"`);
  }
  if (usage.kind === 'unavailable') markup += box(usage.rect, hatch);
  if (usage.kind === 'zero') markup += box(usage.rect, zero);
  if (usage.kind === 'stack') {
    markup += usage.segments
      .map((segment) =>
        box(segment.rect, segment.provider === 'claude' ? claude : providerColors.codex),
      )
      .join('');
  }
  if (rail.kind !== 'empty') {
    markup +=
      rail.kind === 'complete'
        ? box(rail.rect, colors['border-strong'])
        : rail.kind === 'partial'
          ? box(rail.rect, hatch, ` stroke="${colors['coverage-hatch']}" stroke-width="0.75"`)
          : box(rail.rect, colors.surface, ` stroke="${colors['border-strong']}"`);
  }
  return markup;
}

function chartLayers(layout: ChartLayout, id: string) {
  const panels = [layout.delivery, layout.usage];
  const grids = panels
    .flatMap(({ ticks }) =>
      ticks.map(
        ({ y, baseline }) =>
          `<line x1="${layout.padLeft}" x2="${layout.width - layout.padRight}" y1="${y}" y2="${y}" stroke="${baseline ? colors['border-strong'] : colors.border}"${baseline ? '' : ' stroke-dasharray="2 4"'}/>`,
      ),
    )
    .join('');
  const layers: string[] = [];
  // Each icon is limited to 64 KiB by Paseo, even at day granularity over the full lookback.
  const batchSize = 90;
  for (let i = 0; i < layout.buckets.length; i += batchSize) {
    const hatch = `${id}-coverage-${i}`;
    const claude = `${id}-claude-${i}`;
    const patterns = `<defs>${pattern(hatch, 'coverage')}${pattern(claude, 'claude')}</defs>`;
    layers.push(
      patterns +
        layout.buckets
          .slice(i, i + batchSize)
          .map((shape) => marks(shape, `url(#${hatch})`, `url(#${claude})`))
          .join(''),
    );
  }
  if (layout.notes.length > 0) {
    layers.push(
      layout.notes
        .map(({ box: rect }) => box(rect, colors.surface, ` rx="4" stroke="${colors.border}"`))
        .join(''),
    );
  }
  return { grids, layers };
}

export function NativeChartDrawing({
  layout,
  selected,
  cursor,
  hovered,
}: {
  layout: ChartLayout;
  selected: number;
  cursor: number;
  hovered: number;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { width, height, delivery, usage } = layout;
  const { grids, layers } = useMemo(() => chartLayers(layout, `hq${id}`), [layout, id]);
  const selectedBand = layout.buckets[selected]?.band;
  const hoveredBand = hovered !== selected ? layout.buckets[hovered]?.band : undefined;
  const cursorBand = layout.buckets[cursor]?.band;
  const interactionLayer =
    (selectedBand ? box(selectedBand, colors['selection-surface']) : '') +
    (hoveredBand ? box(hoveredBand, colors.canvas) : '') +
    (cursorBand
      ? box(
          cursorBand,
          'none',
          ` stroke="${colors.focus}" stroke-width="1.5" stroke-dasharray="3 2"`,
        )
      : '');
  return (
    <>
      <ReportSvg width={width} height={height} layers={[grids + interactionLayer, ...layers]} />
      <PlotPanelTitle y={delivery.titleY} title="Merged PRs" unit="count" />
      <PlotPanelTitle y={usage.titleY} title="Recorded local tokens" unit="tokens, this machine" />
      {[...delivery.ticks, ...usage.ticks].map(({ y, label }) =>
        label === null ? null : (
          <PlotLabel key={y} x={0} y={y + 4} width={layout.padLeft - 8} align="right">
            {label}
          </PlotLabel>
        ),
      )}
      {layout.notes.map((note) => (
        <PlotLabel
          key={`${note.kind}-${note.x}`}
          x={note.box.x}
          y={note.y}
          width={note.box.width}
          align="center"
        >
          {note.text}
        </PlotLabel>
      ))}
      {layout.upcomingNote && (
        <PlotLabel
          x={layout.upcomingNote.x - 40}
          y={layout.upcomingNote.y}
          width={80}
          align="center"
        >
          {layout.upcomingNote.text}
        </PlotLabel>
      )}
      {layout.xLabels.map((label) => (
        <PlotLabel
          key={label.index}
          x={Math.max(0, Math.min(label.x - 29, width - 58))}
          y={label.y}
          width={58}
          align="center"
        >
          {label.text}
        </PlotLabel>
      ))}
    </>
  );
}
