// The aligned delivery/usage chart (M7, assignment A26). Overview and Trends draw `AlignedChart`; `layoutAlignedChart` is the
// pure geometry behind it, exported for tests and for anything that needs to know where a bucket is drawn.
export { AlignedChart, type AlignedChartProps, type ChartView } from './AlignedChart';
export {
  GEOMETRY,
  layoutAlignedChart,
  niceMax,
  type BucketShape,
  type ChartLayout,
  type ChartNote,
  type LayoutOptions,
} from './layout';
