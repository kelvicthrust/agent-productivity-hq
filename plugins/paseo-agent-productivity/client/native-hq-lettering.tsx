import { Icon } from '@getpaseo/plugin/client/ui';
import { Text, View } from 'react-native';
import { playpen } from './native-hq-font.generated.ts';
import { fitRoomLettering, playpenWidth } from './native-hq-letter-metrics.ts';
import type { DrawingLabel } from './native-hq-svg.ts';

// The SVG viewBox positions each glyph's baseline and accommodates its full ink bounds.
// Keeping glyph shapes separate from positions avoids retaining live labels in Paseo's icon cache.
const VIEWBOX = '-50 -125 200 200';

export function Lettering({ label }: { label: DrawingLabel }) {
  const { x, y, size, color, centered, maxWidth, priority, rotation, weight } = label;
  const words =
    maxWidth === undefined
      ? label.words
      : fitRoomLettering(
          label.words,
          maxWidth,
          (text) => playpenWidth(text, size, weight),
          priority,
        );
  const characters = Array.from(words.normalize('NFC'));
  const glyphs = characters.map((character) => playpen[weight]?.[character]);
  const [angle, cx, cy] = rotation ?? [0, x, y];
  const radians = (angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const left = cx + (x - cx) * cosine - (y - cy) * sine;
  const top = cy + (x - cx) * sine + (y - cy) * cosine;
  const width = glyphs.reduce((total, glyph) => total + (glyph?.[0] ?? 0.6) * size, 0);
  let advance = centered ? -width / 2 : 0;
  return (
    <View
      style={{
        position: 'absolute',
        left,
        top,
        width: 0,
        height: 0,
        transform: [{ rotate: `${angle}deg` }],
      }}
    >
      {glyphs.map((glyph, index) => {
        const glyphLeft = advance;
        advance += (glyph?.[0] ?? 0.6) * size;
        if (!glyph) {
          return (
            <Text
              key={index}
              style={{
                position: 'absolute',
                left: glyphLeft,
                top: -size,
                width: size * 2,
                fontSize: size,
                lineHeight: size * 1.2,
                color,
              }}
            >
              {characters[index]}
            </Text>
          );
        }
        if (!glyph[1]) return null;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}"><path fill="${color}" d="${glyph[1]}"/></svg>`;
        return (
          <View
            key={index}
            style={{
              position: 'absolute',
              left: glyphLeft - size / 2,
              top: -size * 1.25,
              width: size * 2,
              height: size * 2,
            }}
          >
            <Icon icon={{ svg }} size={size * 2} />
          </View>
        );
      })}
    </View>
  );
}
