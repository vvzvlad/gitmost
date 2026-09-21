/**
 * Public surface of the SVG -> PNG rasterizer (Phase A of #585).
 */
export { rasterizeSvgToPng, shutdownRasterizer } from './rasterize';
export type { RasterizeOptions, RasterizeResult } from './rasterize';
export {
  RASTER_MAX_LONGEST_SIDE_PX,
  RASTER_MAX_SVG_BYTES,
  RASTER_TIMEOUT_MS,
  RASTER_DEFAULT_BACKGROUND,
  RASTER_DEFAULT_FONT_FAMILY,
} from './rasterize.constants';
