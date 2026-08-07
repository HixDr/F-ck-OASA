/**
 * User "stamp" pins — shared by both map screens.
 *
 * Memoized on the stamp list so panning, polling and selection changes on the
 * parent screen do not re-render every pin.
 */

import React, { memo, useCallback } from 'react';
import { Alert, Text, View } from 'react-native';
import { Marker } from 'react-native-maps';
import { useMarkerTracking } from '../../../hooks/useMarkerTracking';
import { mapStyles as ms } from '../../../theme/mapStyles';
import type { MapStamp } from '../../../types';

interface StampProps {
  id: string;
  lat: number;
  lng: number;
  emoji: string;
  name: string;
  onRemove: (id: string, name: string) => void;
}

const StampMarker = memo(function StampMarker({
  id, lat, lng, emoji, name, onRemove,
}: StampProps) {
  // Per marker, so adding one stamp does not re-rasterize all the others.
  const { tracksViewChanges, onLayout } = useMarkerTracking([emoji, name]);
  const handlePress = useCallback(() => onRemove(id, name), [onRemove, id, name]);
  return (
    <Marker
      coordinate={{ latitude: lat, longitude: lng }}
      anchor={CENTER_ANCHOR}
      tracksViewChanges={tracksViewChanges}
      onPress={handlePress}
    >
      <View style={ms.stampMarker} collapsable={false} onLayout={onLayout}>
        <Text style={ms.stampEmoji}>{emoji}</Text>
        <Text style={ms.stampLabel}>{name}</Text>
      </View>
    </Marker>
  );
});

const CENTER_ANCHOR = { x: 0.5, y: 0.5 };

interface Props {
  stamps: MapStamp[];
  onRemove: (id: string) => void;
}

const StampLayer = memo(function StampLayer({ stamps, onRemove }: Props) {
  const confirmRemove = useCallback((id: string, name: string) => {
    Alert.alert('Remove stamp?', `Delete "${name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onRemove(id) },
    ]);
  }, [onRemove]);

  return (
    <>
      {stamps.map((st) => (
        <StampMarker
          key={`stamp-${st.id}`}
          id={st.id} lat={st.lat} lng={st.lng}
          emoji={st.emoji} name={st.name}
          onRemove={confirmRemove}
        />
      ))}
    </>
  );
});

export default StampLayer;
