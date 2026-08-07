/**
 * NearbyMapScreen styles.
 *
 * The stop card that used to live here moved to `src/ui/StopSheet`, which both
 * map screens now share; what is left is the native marker, which
 * `components/StopMarkers` renders.
 */

import { StyleSheet } from 'react-native';

export const s = StyleSheet.create({
  stopPin: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  stopPinInner: { width: 4, height: 6, borderRadius: 1, backgroundColor: '#FFF' },
});
