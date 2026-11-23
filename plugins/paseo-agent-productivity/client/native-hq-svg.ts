import { isValidElement, type ReactElement } from 'react';
import { isMotionKind, type DrawingMotion, type MotionKind } from './native-hq-motion.tsx';
import { hqColors } from './native-hq-palette.generated.ts';

type Props = Record<string, unknown> & { children?: unknown; className?: string };

const tags = new Set(['circle', 'ellipse', 'g', 'line', 'path', 'polygon', 'polyline', 'rect']);
const attributes = new Set([
  'cx',
  'cy',
  'd',
  'fill',
  'fillOpacity',
  'height',
  'opacity',
  'points',
  'r',
  'rx',
  'ry',
  'stroke',
  'strokeDasharray',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeOpacity',
  'strokeWidth',
  'transform',
  'vectorEffect',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
]);

function xml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const escape: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return escape[character];
  });
}

function svgColor(role: string): string | undefined {
  if (role === 'none') return 'none';
  return hqColors[role as keyof typeof hqColors];
}

export interface DrawingLabel {
  x: number;
  y: number;
  size: number;
  weight: number;
  color: string;
  centered: boolean;
  words: string;
  maxWidth?: number;
  priority?: string;
  rotation: readonly [angle: number, cx: number, cy: number] | null;
}

type Layer = { open: string; close: string; transform?: string };

interface DrawingExport {
  labels: DrawingLabel[];
  moves: Array<Omit<DrawingMotion, 'icon'> & { markup: string }> | null;
}

const pivots: Partial<Record<MotionKind, readonly [number, number]>> = {
  tilt: [310.7, 277.9],
  shake: [695.3, 152],
  swivel: [0, 0],
};

/** Position the original paper, exclamation mark or chair's pivot in room coordinates. */
function motionOrigin(kind: MotionKind, ancestors: readonly Layer[]): readonly [number, number] {
  let [x, y] = pivots[kind] ?? [0, 0];
  if (!pivots[kind]) return [x, y];
  for (const layer of [...ancestors].reverse()) {
    const transforms = layer.transform?.matchAll(/(translate|scale)\(([^)]+)\)/g);
    for (const [, operation, values] of [...(transforms ?? [])].reverse()) {
      const [a, b] = values.trim().split(/[ ,]+/).map(Number);
      if (operation === 'scale') {
        x *= a;
        y *= b ?? a;
      } else {
        x += a;
        y += b ?? 0;
      }
    }
  }
  return [x, y];
}

function svgNode(
  node: unknown,
  drawing: DrawingExport,
  ancestors: readonly Layer[] = [],
  rotation: DrawingLabel['rotation'] = null,
): string {
  if (Array.isArray(node))
    return node.map((child) => svgNode(child, drawing, ancestors, rotation)).join('');
  if (!isValidElement<Props>(node)) return '';
  const { type, props } = node;
  if (typeof type === 'function')
    return svgNode((type as (props: Props) => unknown)(props), drawing, ancestors, rotation);
  const styles: Record<string, string> = {};
  for (const token of props.className?.split(' ') ?? []) {
    const [attribute, ...name] = token.split('-');
    if (attribute !== 'fill' && attribute !== 'stroke') continue;
    const color = svgColor(name.join('-'));
    if (color) styles[attribute] = color;
  }
  if (type === 'text') {
    drawing.labels.push({
      x: Number(props.x ?? 0),
      y: Number(props.y ?? 0),
      size: Number(props.fontSize ?? 13),
      weight: Number(props.fontWeight ?? 400),
      color: styles.fill ?? hqColors.ink,
      centered: props.textAnchor === 'middle',
      words: String(props.children ?? ''),
      maxWidth:
        typeof props['data-hq-max-width'] === 'number' ? props['data-hq-max-width'] : undefined,
      priority:
        typeof props['data-hq-priority'] === 'string' ? props['data-hq-priority'] : undefined,
      rotation,
    });
    return '';
  }
  if (typeof type !== 'string' || !tags.has(type))
    return svgNode(props.children, drawing, ancestors, rotation);
  const animation = drawing.moves && /animate-\[hq-(\w+)_([\d.]+)s/.exec(props.className ?? '');
  const kind = animation?.[1];
  const moving = kind && isMotionKind(kind) ? kind : undefined;
  const svgAttributes = Object.entries(props).flatMap(([name, value]) =>
    attributes.has(name) &&
    !(name in styles) &&
    (name !== 'opacity' || !moving) &&
    (typeof value === 'string' || typeof value === 'number')
      ? [`${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${xml(value)}"`]
      : [],
  );
  for (const [name, value] of Object.entries(styles)) svgAttributes.push(`${name}="${value}"`);
  const layer: Layer = {
    open: `<${type} ${svgAttributes.join(' ')}>`,
    close: `</${type}>`,
    transform: typeof props.transform === 'string' ? props.transform : undefined,
  };
  const rotated = layer.transform
    ? /^rotate\((-?[\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(layer.transform)
    : null;
  const children = svgNode(
    props.children,
    drawing,
    [...ancestors, layer],
    rotated ? [Number(rotated[1]), Number(rotated[2]), Number(rotated[3])] : rotation,
  );
  const markup =
    children || props.children
      ? `${layer.open}${children}${layer.close}`
      : `<${type} ${svgAttributes.join(' ')}/>`;
  if (drawing.moves && moving && animation) {
    const shift = /animation-delay:-([\d.]+)s/.exec(props.className ?? '');
    drawing.moves.push({
      kind: moving,
      duration: Number(animation[2]) * 1000,
      shift: shift ? Number(shift[1]) * 1000 : 0,
      origin: motionOrigin(moving, [...ancestors, layer]),
      markup: ancestors.reduceRight(
        (inner, parent) => `${parent.open}${inner}${parent.close}`,
        markup,
      ),
    });
    return '';
  }
  return markup;
}

/** Paseo's Icon has a square view, so room art is arranged from the top left before scaling. */
export function drawingAssets(drawing: ReactElement, width: number, animate: boolean) {
  const output: DrawingExport = { labels: [], moves: animate ? [] : null };
  const wrap = (markup: string) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${width}" preserveAspectRatio="xMinYMin slice">${markup}</svg>`,
  });
  const art = svgNode(drawing, output);
  return {
    icon: wrap(art),
    labels: output.labels,
    motions:
      output.moves?.map(({ markup, ...motion }) => ({ ...motion, icon: wrap(markup) })) ?? [],
  };
}
