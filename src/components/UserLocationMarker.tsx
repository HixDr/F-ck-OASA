import React, { memo } from 'react';
import { View, Image } from 'react-native';
import { Marker } from 'react-native-maps';
import HeadingBeam from './HeadingBeam';
import { USER_MARKER_BASE64 } from '../data/userMarker';
import { useMarkerTracking } from '../hooks/useMarkerTracking';
import { mapStyles as ms } from '../theme/mapStyles';

interface Props {
  lat: number;
  lng: number;
  heading: number | null;
  iconStyle: string;
}

/**
 * Shared user-location marker rendered on the map.
 * Supports both the "cat" icon and the standard blue-dot with heading beam.
 *
 * The heading beam is rotated by the Marker's native `rotation` prop rather
 * than a JS `transform`. A transform changes the marker's *view*, which forces
 * react-native-maps to re-capture the bitmap on every compass tick — the old
 * code paired it with a 400ms tracking burst that re-armed continuously while
 * walking. `rotation` + `flat` rotates the already-cached bitmap natively, so
 * tracking can stay off except for the one burst on icon change.
 */
const UserLocationMarker = memo(function UserLocationMarker({
  lat,
  lng,
  heading,
  iconStyle,
}: Props) {
  // The only two things that change the marker's *pixels*: which icon it is,
  // and whether the beam exists at all (heading acquired / lost).
  const { tracksViewChanges, onLayout } = useMarkerTracking([iconStyle, heading != null]);
  const isCat = iconStyle === 'cat';

  return (
    <Marker
      key={`user-${iconStyle}`}
      coordinate={{ latitude: lat, longitude: lng }}
      anchor={ANCHOR}
      tracksViewChanges={tracksViewChanges}
      // The cat icon is a picture of a cat; spinning it with the compass would
      // be nonsense. Only the blue dot's beam is directional.
      rotation={!isCat && heading != null ? heading : 0}
      flat
      zIndex={999}
    >
      {isCat ? (
        <Image source={{ uri: USER_MARKER_BASE64 }} style={ms.catIcon} onLayout={onLayout} />
      ) : (
        <View style={ms.userMarkerWrap} collapsable={false} onLayout={onLayout}>
          {heading != null && (
            <View style={ms.headingBeam}>
              <HeadingBeam />
            </View>
          )}
          <View style={ms.userDot}>
            <View style={ms.userDotInner} />
          </View>
        </View>
      )}
    </Marker>
  );
});

const ANCHOR = { x: 0.5, y: 0.5 };

export default UserLocationMarker;
