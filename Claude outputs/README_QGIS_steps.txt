SENTINEL-2 IN QGIS - Black Forest, 2 dates (real data, free, no login)
=====================================================================
Tile 32UMU (Black Forest, Germany). Files are on AWS (Earth Search) as
Cloud-Optimised GeoTIFFs, so QGIS streams them: no big download needed.

CLEAR DAY: 5 Oct 2026, Sentinel-2B, cloud 11%
  True colour : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2B_32UMU_20261005_0_L2A/TCI.tif
  Red   B04   : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2B_32UMU_20261005_0_L2A/B04.tif
  NIR   B08   : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2B_32UMU_20261005_0_L2A/B08.tif
  SWIR  B11   : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2B_32UMU_20261005_0_L2A/B11.tif
  Cloud mask  : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2B_32UMU_20261005_0_L2A/SCL.tif

CLOUDY DAY: 22 Oct 2026, Sentinel-2A, cloud 46%
  True colour : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2A_32UMU_20261022_1_L2A/TCI.tif
  Red   B04   : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2A_32UMU_20261022_1_L2A/B04.tif
  NIR   B08   : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2A_32UMU_20261022_1_L2A/B08.tif
  SWIR  B11   : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2A_32UMU_20261022_1_L2A/B11.tif
  Cloud mask  : https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/U/MU/2026/10/S2A_32UMU_20261022_1_L2A/SCL.tif

STEPS
1. Background map: Browser panel (left) > XYZ Tiles > OpenStreetMap > double-click.
2. Open a band: Layer > Add Layer > Add Raster Layer > Source type "Protocol: HTTP(S), cloud, etc."
   > paste a link above > Add. Start with True colour of both days.
3. Zoom: right-click the layer > Zoom to Layer, then zoom into the Black Forest.
4. Cloud mask colours: add SCL.tif, right-click > Properties > Symbology > Style (bottom)
   > Load Style > pick SCL_cloud_mask_style.qml. White/grey = cloud, brown = shadow.
5. NDVI: add B04 and B08 of the same day, then Raster > Raster Calculator:
      ( "B08@1" - "B04@1" ) / ( "B08@1" + "B04@1" )
   Save as NDVI_20261005.tif. Symbology > Singleband pseudocolor > RdYlGn, min -0.2, max 0.9.
6. NDMI (moisture), same way with B08 and B11. B11 is 20 m, so first set the calculator's
   output to the B08 layer extent/resolution:
      ( "B08@1" - "B11@1" ) / ( "B08@1" + "B11@1" )
7. Compare days: tick/untick layers, or use the Identify tool (i) to click a pixel and read values.
8. Keep a copy offline: right-click a layer > Export > Save As > set extent "Map Canvas Extent" > GeoTIFF.

TIPS
- Tiles are ~110 x 110 km. Keep zoomed in to the area you need, or it is slow.
- Values in B04/B08/B11 are reflectance x 10000 (NDVI ratio works without rescaling).
- Same data source the stats came from: 187 image days, only 43 clear in the last 12 months.
