/**
 * Google Maps–style semi-transparent heading beam (sector/fan shape).
 * 80×80 viewBox, 60° sector centered at (40,40) pointing UP.
 * Rotate externally via the parent View's transform.
 */

import React, { memo } from 'react';
import Svg, { Path, Defs, RadialGradient, Stop } from 'react-native-svg';

/**
 * Sector path: center (40,40), radius 36, ±30° from north.
 *
 * Start  (240°): (40 + 36·cos240°, 40 + 36·sin240°) ≈ (22, 8.8)
 * End    (300°): (40 + 36·cos300°, 40 + 36·sin300°) ≈ (58, 8.8)
 */
const SECTOR = 'M40 40 L22 8.8 A36 36 0 0 1 58 8.8 Z';

const HeadingBeam = memo(function HeadingBeam() {
  return (
    <Svg width={80} height={80} viewBox="0 0 80 80">
      <Defs>
        <RadialGradient
          id="hb"
          cx="40"
          cy="40"
          r="36"
          fx="40"
          fy="40"
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0" stopColor="#4285F4" stopOpacity={0.28} />
          <Stop offset="1" stopColor="#4285F4" stopOpacity={0.03} />
        </RadialGradient>
      </Defs>
      <Path d={SECTOR} fill="url(#hb)" />
    </Svg>
  );
});

export default HeadingBeam;
