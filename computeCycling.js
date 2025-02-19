import distance from '@turf/distance'
import point from 'turf-point'
import isSafePath from './isSafePath'
import { computePointsCenter, pointsProcess } from './pointsRequest'
import { isTransportStop } from './utils'

export const APIUrl = `http://localhost:${process.env.PORT || '3000'}/`

const maxCityDistance = 20 // was used previously, but I think the next threshold is better
const nearestPointsLimit = 4 // 4 is a symbolic number : think of a compass

const createBikeRouterQuery = (from, to) =>
	encodeURIComponent(`${from.reverse().join(',')}|${to.reverse().join(',')}`)

const createItinerary = (from, to) =>
	fetch(
		APIUrl +
			`bikeRouter/${createBikeRouterQuery(
				[from.lat, from.lon],
				[to.lat, to.lon]
			)}`
	)
		.then((res) => res.json())
		.then(
			(json) =>
				console.log('brouter response') || {
					...json,
					fromPoint: from.id,
					toPoint: to.id,
					backboneRide: to.tags.amenity === 'townhall',
				}
		)

export const segmentGeoJSON = (geojson) => {
	if (geojson.features.length > 1) throw Error('Oulala pas prévu ça')
	const table = getMessages(geojson)
	const coordinateStringToNumber = (string) => +string / 10e5
	const getLineCoordinates = (line) =>
			line && [line[0], line[1]].map(coordinateStringToNumber),
		getLineDistance = (line) => line[3],
		getLineTags = (line) => line[9]

	const { toPoint, fromPoint, backboneRide } = geojson
	let lineStringCoordinates = geojson.features[0].geometry.coordinates
	// As I understand this, the "messages" table contains brouter's real measurement of distance
	// in segments that are grouped, maybe according to tags ?
	// The LineString ('geometry') contains the real detailed shape
	// Important info for score calculation is contained in the table,
	// whereas important info for map display is contained in the LineString
	// from the first lineString coords to the first message coords (that correspond to another linestring coord), apply the properties of the message
	// ...
	// until the last lineString coord, apply the properties of the message, that goes way further in termes of coords but whose distance is right
	const featureCollection = {
		type: 'FeatureCollection',
		features: table
			.map((line, i) => {
				const [lon, lat] = getLineCoordinates(line)
				return {
					type: 'Feature',
					properties: {
						tags: getLineTags(line),
						distance: line[3],
						elevation: line[2],
						backboneRide,
						isSafePath: isSafePath(getLineTags(line)),
						toPoint,
						fromPoint,
					},
					geometry: {
						type: 'LineString',
						coordinates: (() => {
							const selected = lineStringCoordinates.reduce(
								([selected, shouldContinue, rest], next) => {
									const [lon2, lat2] = next
									const foundBoundary = lon2 == lon && lat2 == lat
									if (!shouldContinue) return [selected, false, [...rest, next]]
									if (!foundBoundary) return [[...selected, next], true, rest]
									if (foundBoundary) return [[...selected, next], false, [next]]
								},
								[[], true, []]
							)
							lineStringCoordinates = selected[2]

							return selected[0]
						})(),
					},
				}
			})
			.filter(Boolean),
	}
	return featureCollection
}

export const getMessages = (geojson) => {
	const [_, ...table] = geojson.features[0].properties.messages

	return table
}
export const computeSafePercentage = (messages) => {
	const [safeDistance, total] = messages.reduce(
		(memo, next) => {
			const safe = isSafePath(next[9]),
				distance = next[3]
			return [memo[0] + (safe ? +distance : 0), memo[1] + +distance]
		},
		[0, 0]
	)

	return (safeDistance / total) * 100
}

export const ridesPromises = (points) =>
	points
		.map((p, i) => {
			const point1 = point([p.lon, p.lat])

			const sorted = points
				.filter((p2) => {
					const d = distance(point([p2.lon, p2.lat]), point1)
					return (
						p != p2 && // suffices for now, it's binary
						isTransportStop(p) === isTransportStop(p2) &&
						!(d < 1 && p.tags.name === p2.tags.name)
					)
				})
				.sort(
					(pa, pb) =>
						distance(point([pa.lon, pa.lat]), point1) -
						distance(point([pb.lon, pb.lat]), point1)
				)
			const firstX = sorted.slice(0, nearestPointsLimit)

			return firstX.map((p2, j) =>
				new Promise((resolve) =>
					setTimeout(resolve, itineraryRequestDelay * (i + j))
				).then(() => createItinerary(p, p2).then((res) => res))
			)
		})
		.flat()

const itineraryRequestDelay = 300 // This is fined tuned to handle the brouter server on my computer. It can fail requests at 100

export const isValidRide = (ride) =>
	// Exclude itineraries that include a ferry route.
	// TODO maybe we should just exclude the subrides that are ferry ? Doesn't matter much on the final result
	ride.features &&
	!getMessages(ride).some((ride) => ride[9].includes('route=ferry'))

export default async (ville) => {
	const points = await pointsProcess(ville)
	const pointsCenter = computePointsCenter(points)

	const rides = await Promise.all(ridesPromises(points))

	const filteredRides = rides.filter(isValidRide)

	const score = computeSafePercentage(
		filteredRides.map((ride) => getMessages(ride)).flat()
	)

	const segments = filteredRides
		.map((ride) => segmentGeoJSON(ride))
		.map((r) => r.features)
		.flat()

	return { pointsCenter, points, segments, score, rides }
}
