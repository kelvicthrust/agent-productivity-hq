import { View } from 'react-native';
import { Buddy, CrewArt, type BuddyMood, type CrewMood } from './native-hq-art.generated.mjs';
import { Drawing } from './native-hq-drawing.tsx';
import type { RosterAgent } from './native-types.ts';

export function NativeCrewArt({
  mood = 'awake',
  width = 132,
}: {
  mood?: CrewMood;
  width?: number;
}) {
  return (
    <View
      accessible={false}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Drawing
        drawing={CrewArt({ mood })}
        width={width}
        height={(width * 64) / 132}
        sourceWidth={132}
        sourceHeight={64}
      />
    </View>
  );
}

export function NativeBuddy({
  provider,
  mood = 'awake',
  size = 16,
}: {
  provider: RosterAgent['provider'];
  mood?: BuddyMood;
  size?: number;
}) {
  const kind = provider === 'other' ? 'unknown' : provider;
  return (
    <View
      accessible={false}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Drawing
        drawing={Buddy({ kind, mood })}
        width={size}
        height={size}
        sourceWidth={20}
        sourceHeight={20}
      />
    </View>
  );
}
