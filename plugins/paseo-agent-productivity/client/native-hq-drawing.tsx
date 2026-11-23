import { Icon } from '@getpaseo/plugin/client/ui';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import { Lettering } from './native-hq-lettering.tsx';
import { MovingArt } from './native-hq-motion.tsx';
import { drawingAssets } from './native-hq-svg.ts';

export function Drawing({
  drawing,
  width,
  height,
  sourceWidth = width,
  sourceHeight = height,
  animate = false,
}: {
  drawing: ReactElement;
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
  animate?: boolean;
}) {
  const { icon, labels, motions } = drawingAssets(drawing, sourceWidth, animate);
  return (
    <View style={{ width, height, overflow: 'hidden' }}>
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: sourceWidth,
          height: sourceWidth,
          transformOrigin: 'left top',
          transform: [{ scaleX: width / sourceWidth }, { scaleY: height / sourceHeight }],
        }}
      >
        <Icon icon={icon} size={sourceWidth} />
        {motions.map((motion, index) => (
          <MovingArt key={`${motion.kind}-${index}`} motion={motion} size={sourceWidth} />
        ))}
        {labels.map((label, index) => (
          <Lettering key={index} label={label} />
        ))}
      </View>
    </View>
  );
}
