import React, { memo } from 'react';
import { View, Image } from 'react-native';
import { Marker } from 'react-native-maps';
import HeadingBeam from './HeadingBeam';
import { USER_MARKER_BASE64 } from '../data/userMarker';
import { mapStyles as ms } from '../theme/mapStyles';

interface Props {
  lat: number;
  lng: number;
  heading: number | null;
  iconStyle: string;
  tracksViewChanges: boolean;
}

/**
 * Shared user-location marker rendered on the map.
 * Supports both the "cat" icon and the standard blue-dot with heading beam.
 *
 * Replaces ~20 identical lines in LiveMapScreen and NearbyMapScreen.
 */
const UserLocationMarker = memo(function UserLocationMarker({
  lat,
  lng,
  heading,
  iconStyle,
  tracksViewChanges,
}: Props) {
  return (
    <Marker
      key={`user-${iconStyle}`}
      coordinate={{ latitude: lat, longitude: lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      flat
      zIndex={999}
    >
      {iconStyle === 'cat' ? (
        <Image source={{ uri: USER_MARKER_BASE64 }} style={ms.catIcon} />
      ) : (
        <View style={ms.userMarkerWrap}>
          {heading != null && (
            <View style={[ms.headingBeam, { transform: [{ rotate: `${heading}deg` }] }]}>
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

export default UserLocationMarker;
