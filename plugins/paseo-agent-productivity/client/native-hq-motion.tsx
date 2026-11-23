import { Icon } from '@getpaseo/plugin/client/ui';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform } from 'react-native';

interface MotionFrame {
  opacity?: number;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
}

// Original HQ marks, timed to the stepped CSS keyframes in theme/globals.css.
const frames = {
  flick2: [{ opacity: 1 }, { opacity: 0 }],
  flick3: [{ opacity: 1 }, { opacity: 0 }, { opacity: 0 }],
  dot: [{ opacity: 1 }, { opacity: 0.3 }, { opacity: 0.3 }],
  bob: [{ y: 0 }, { y: -2 }, { y: -3 }, { y: -1 }],
  zed: Array.from({ length: 5 }, (_, i) => ({
    opacity: 1 - i / 5,
    x: (4 * i) / 5,
    y: (-12 * i) / 5,
  })),
  tilt: [{ rotation: 0 }, { rotation: -5 }],
  shake: [
    { x: 0, rotation: 0 },
    { x: -1.5, rotation: -4 },
    { x: 1.5, rotation: 3 },
  ],
  swivel: [1, 0.55, -0.2, -1, -0.55, 0.2].map((scaleX) => ({ scaleX })),
} satisfies Record<string, MotionFrame[]>;

export type MotionKind = keyof typeof frames;
export interface DrawingMotion {
  kind: MotionKind;
  duration: number;
  shift: number;
  origin: readonly [number, number];
  icon: { svg: string };
}

export function isMotionKind(kind: string): kind is MotionKind {
  return Object.hasOwn(frames, kind);
}

type MotionQuery = {
  matches: boolean;
  addEventListener(event: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(event: 'change', listener: (event: { matches: boolean }) => void): void;
};

export function useHqMotion(): boolean {
  // Keep the first drawing still until the system setting has been read.
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const browser = globalThis as typeof globalThis & {
        matchMedia?: (query: string) => MotionQuery;
      };
      const query = browser.matchMedia?.('(prefers-reduced-motion: reduce)');
      if (!query) return;
      const change = (event: { matches: boolean }) => setEnabled(!event.matches);
      change(query);
      query.addEventListener('change', change);
      return () => query.removeEventListener('change', change);
    }
    let active = true;
    let eventReceived = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (reduced) => {
      eventReceived = true;
      setEnabled(!reduced);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (reduced) => {
        if (active && !eventReceived) setEnabled(!reduced);
      },
      () => undefined,
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return enabled;
}

function steppedStyle(progress: Animated.Value, motion: DrawingMotion) {
  const variants: MotionFrame[] = frames[motion.kind];
  const shifted = Math.round((motion.shift / motion.duration) * variants.length);
  const order = Array.from(
    { length: variants.length },
    (_, i) => variants[(i + shifted) % variants.length],
  );
  const inputRange = order.flatMap((_, index) => [
    index / order.length,
    (index + 1) / order.length - 0.001,
  ]);
  inputRange.push(1);
  const values = (key: keyof MotionFrame, fallback: number) => {
    const steps = order.flatMap((frame) => [frame[key] ?? fallback, frame[key] ?? fallback]);
    return [...steps, steps[0]];
  };
  const interpolate = (key: keyof MotionFrame, fallback: number) =>
    progress.interpolate({ inputRange, outputRange: values(key, fallback) });
  const [x, y] = motion.origin;
  return {
    opacity: interpolate('opacity', 1),
    transformOrigin: `${x}px ${y}px`,
    transform: [
      { translateX: interpolate('x', 0) },
      { translateY: interpolate('y', 0) },
      {
        rotate: progress.interpolate({
          inputRange,
          outputRange: values('rotation', 0).map((angle) => `${angle}deg`),
        }),
      },
      { scaleX: interpolate('scaleX', 1) },
    ],
  };
}

export function MovingArt({ motion, size }: { motion: DrawingMotion; size: number }) {
  const [progress] = useState(() => new Animated.Value(0));
  const duration = motion.duration;
  const style = useMemo(() => steppedStyle(progress, motion), [progress, motion]);
  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [progress, duration]);
  return (
    <Animated.View
      style={[{ position: 'absolute', top: 0, left: 0, width: size, height: size }, style]}
    >
      <Icon icon={motion.icon} size={size} />
    </Animated.View>
  );
}
