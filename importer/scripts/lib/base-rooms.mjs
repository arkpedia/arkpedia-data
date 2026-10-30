/**
 * building_data's roomType -> the facility label base skills are stored and matched under.
 * One list for the English refresh, the Base skill importer and its audit: three copies drifted
 * when CN added its Recycling Station, so Homebound's skills were stored as "RECYCLE" by one and
 * refused as an "unknown buff" by another (issue #59, 2026-10-13).
 *
 * RECYCLE (回收站, CN only): no official English name yet, so "Recycling Station" is our
 * translation; replace it with Global's name when Global adds the facility.
 */
export const BASE_ROOMS = Object.freeze({
  CONTROL: 'Control Center', DORMITORY: 'Dormitory', HIRE: 'Office', MANUFACTURE: 'Factory',
  MEETING: 'Reception Room', POWER: 'Power Plant', TRADING: 'Trading Post',
  TRAINING: 'Training Room', WORKSHOP: 'Workshop', RECYCLE: 'Recycling Station',
});

/** A stored facility as its label: older records kept a raw roomType ("RECYCLE"). */
export const facilityLabel = facility => BASE_ROOMS[facility] ?? facility;
