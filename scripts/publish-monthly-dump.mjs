import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { createClient } from '@supabase/supabase-js';
import { MongoClient } from 'mongodb';

const GAME_URL_PREFIX = 'https://realgolf.games/game/';
const OUTPUT_DIRECTORY = path.resolve(process.cwd(), 'artifacts');
const COLLECTION_NAME = process.env.MONGODB_COLLECTION || 'games';

function requireEnv(name) {
	const value = process.env[name];

	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}

	return value;
}

function getByPath(object, pathExpression) {
	return pathExpression.split('.').reduce((value, segment) => value?.[segment], object);
}

function pick(object, paths) {
	for (const pathExpression of paths) {
		const value = getByPath(object, pathExpression);

		if (value !== undefined && value !== null) {
			return value;
		}
	}

	return undefined;
}

function assertString(value, label) {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'bigint') {
		return String(value);
	}

	if (value && typeof value === 'object') {
		if (typeof value.toHexString === 'function') {
			return value.toHexString();
		}

		if (typeof value.toString === 'function') {
			const stringValue = value.toString();

			if (stringValue && stringValue !== '[object Object]') {
				return stringValue;
			}
		}
	}

	throw new Error(`Missing required string field: ${label}`);
}

function assertNumber(value, label) {
	const numericValue = Number(value);

	if (Number.isFinite(numericValue)) {
		return numericValue;
	}

	throw new Error(`Missing required numeric field: ${label}`);
}

function normalizeDate(value, label) {
	const date = value instanceof Date ? value : new Date(value);

	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid date field: ${label}`);
	}

	return date.toISOString();
}

function escapeTagValue(value) {
	return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function formatTag(key, value) {
	return `[${key} "${escapeTagValue(value)}"]`;
}

function formatOptionalValue(value) {
	if (value === undefined || value === null || value === '') {
		return '-';
	}

	return assertString(value, 'optional');
}

function formatPlayerData(value) {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}

	if (!Array.isArray(value) || value.length === 0) {
		return '-';
	}

	return value.map((entry) => assertString(entry, 'player.data')).join(',');
}

function normalizePlayers(game) {
	const players = pick(game, ['players', 'participants']);

	if (!Array.isArray(players) || players.length === 0) {
		throw new Error(`Game ${pick(game, ['_id', 'id']) ?? 'unknown'} has no players`);
	}

	return [...players]
		.map((player, index) => ({ player, index }))
		.sort((left, right) => {
			const leftPos = Number(pick(left.player, ['pos', 'position'])) || left.index + 1;
			const rightPos = Number(pick(right.player, ['pos', 'position'])) || right.index + 1;
			return leftPos - rightPos;
		})
		.map(({ player }) => player);
}

function normalizeWinner(game, players) {
	const directWinner = pick(game, ['winner', 'result.winner']);

	if (directWinner && typeof directWinner === 'object') {
		return directWinner;
	}

	const flaggedWinner = players.find((player) =>
		[pick(player, ['winner', 'is_winner', 'isWinner']), pick(player, ['result', 'placement'])].some(
			(value) => value === true || value === 'winner' || value === 1 || value === '1',
		),
	);

	if (flaggedWinner) {
		return flaggedWinner;
	}

	throw new Error(`Game ${pick(game, ['_id', 'id']) ?? 'unknown'} is missing a winner`);
}

function formatCompetitor(competitor, label) {
	return [
		assertNumber(pick(competitor, ['pos', 'position']), `${label}.pos`),
		assertString(pick(competitor, ['name', 'username', 'display_name', 'displayName']), `${label}.name`),
		assertString(pick(competitor, ['player_id', 'playerId', 'id', '_id']), `${label}.player_id`),
		assertString(pick(competitor, ['color']), `${label}.color`),
		formatOptionalValue(pick(competitor, ['points'])),
		formatOptionalValue(pick(competitor, ['shots'])),
	].join('|');
}

function formatPlayer(player) {
	return `${formatCompetitor(player, 'player')}|${formatPlayerData(pick(player, ['data']))}`;
}

function normalizeBoardCell(cell) {
	if (cell === undefined || cell === null || cell === '' || cell === 'empty') {
		return 'empty';
	}

	if (typeof cell === 'string') {
		return cell;
	}

	if (typeof cell === 'object') {
		const color = pick(cell, ['color']);
		const playerId = pick(cell, ['player_id', 'playerId', 'id', '_id']);

		if (color && playerId) {
			return `${color}:${playerId}`;
		}
	}

	throw new Error(`Unsupported board cell value: ${JSON.stringify(cell)}`);
}

function renderBoard(game, mode) {
	if (mode !== '4winning') {
		return [];
	}

	const board = pick(game, ['board', 'state.board', 'grid']);

	if (!Array.isArray(board)) {
		throw new Error(`Game ${pick(game, ['_id', 'id']) ?? 'unknown'} is missing a board`);
	}

	return [
		'BOARD',
		...board.map((row) => {
			if (Array.isArray(row)) {
				return row.map((cell) => normalizeBoardCell(cell)).join(',');
			}

			if (typeof row === 'string') {
				return row;
			}

			throw new Error(`Unsupported board row value: ${JSON.stringify(row)}`);
		}),
		'ENDBOARD',
	];
}

function renderGame(game) {
	const gameId = assertString(pick(game, ['id', '_id']), 'id');
	const mode = assertString(pick(game, ['mode']), 'mode');
	const createdAt = normalizeDate(pick(game, ['created_at', 'createdAt']), 'created_at');
	const updatedAt = normalizeDate(
		pick(game, ['updated_at', 'updatedAt', 'created_at', 'createdAt']),
		'updated_at',
	);
	const players = normalizePlayers(game);
	const winner = normalizeWinner(game, players);
	const totalShots =
		pick(game, ['total_shots', 'totalShots']) ??
		players.reduce((sum, player) => {
			const shots = Number(pick(player, ['shots']));
			return Number.isFinite(shots) ? sum + shots : sum;
		}, 0);
	const movesCount =
		pick(game, ['moves_count', 'movesCount']) ??
		(Array.isArray(pick(game, ['moves'])) ? pick(game, ['moves']).length : undefined);
	const duration =
		pick(game, ['duration']) ??
		Math.max(0, Math.floor((new Date(updatedAt).getTime() - new Date(createdAt).getTime()) / 1000));

	return [
		formatTag('GGN', '1.0'),
		formatTag('ID', gameId),
		formatTag('Mode', mode),
		formatTag('Date', createdAt),
		formatTag('Updated', updatedAt),
		formatTag('URL', pick(game, ['url']) ?? `${GAME_URL_PREFIX}${encodeURIComponent(gameId)}`),
		formatTag('Winner', formatCompetitor(winner, 'winner')),
		formatTag('TotalShots', assertNumber(totalShots, 'total_shots')),
		formatTag('ShotsLeft', assertNumber(pick(game, ['shots_left', 'shotsLeft']), 'shots_left')),
		formatTag('MovesCount', assertNumber(movesCount, 'moves_count')),
		formatTag('Duration', assertNumber(duration, 'duration')),
		'',
		...players.map((player) => formatTag('Player', formatPlayer(player))),
		...renderBoard(game, mode),
	].join('\n');
}

async function writeLine(stream, line) {
	if (stream.write(`${line}\n`)) {
		return;
	}

	await new Promise((resolve, reject) => {
		stream.once('drain', resolve);
		stream.once('error', reject);
	});
}

function getMonthWindow(now = new Date()) {
	const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const previousMonthStart = new Date(
		Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - 1, 1),
	);

	return { previousMonthStart, currentMonthStart };
}

function getFileStem(date) {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function createDumpFile(mongodbUri, outputPath) {
	const { previousMonthStart, currentMonthStart } = getMonthWindow();
	const client = new MongoClient(mongodbUri);
	const stream = createWriteStream(outputPath, { encoding: 'utf8' });
	let count = 0;

	try {
		await client.connect();

		const cursor = client.db().collection(COLLECTION_NAME).find(
			{
				is_public: true,
				created_at: {
					$gte: previousMonthStart,
					$lt: currentMonthStart,
				},
			},
			{
				projection: {
					user_id: 0,
					__v: 0,
				},
				sort: {
					created_at: 1,
					_id: 1,
				},
			},
		);

		for await (const game of cursor) {
			await writeLine(stream, JSON.stringify(renderGame(game)));
			count += 1;
		}
	} finally {
		stream.end();
		await Promise.allSettled([
			client.close(),
			new Promise((resolve, reject) => {
				stream.on('finish', resolve);
				stream.on('error', reject);
			}),
		]);
	}

	return count;
}

async function gzipFile(sourcePath, destinationPath) {
	await pipeline(createReadStream(sourcePath), createGzip({ level: 9 }), createWriteStream(destinationPath));
}

async function uploadDump(supabaseUrl, supabaseKey, fileName, filePath) {
	const supabase = createClient(supabaseUrl, supabaseKey);
	const file = await readFile(filePath);
	const { error } = await supabase.storage.from('dumps').upload(fileName, file, {
		contentType: 'application/gzip',
		upsert: true,
	});

	if (error) {
		throw error;
	}
}

async function main() {
	const mongodbUri = requireEnv('MONGODB_URI');
	const supabaseUrl = requireEnv('SUPABASE_URL');
	const supabaseKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
	const { previousMonthStart } = getMonthWindow();
	const fileStem = getFileStem(previousMonthStart);
	const rawFileName = `${fileStem}.ggn`;
	const gzipFileName = `${rawFileName}.gz`;
	const rawFilePath = path.join(OUTPUT_DIRECTORY, rawFileName);
	const gzipFilePath = path.join(OUTPUT_DIRECTORY, gzipFileName);

	await mkdir(OUTPUT_DIRECTORY, { recursive: true });

	const gameCount = await createDumpFile(mongodbUri, rawFilePath);
	await gzipFile(rawFilePath, gzipFilePath);
	await uploadDump(supabaseUrl, supabaseKey, gzipFileName, gzipFilePath);

	console.log(`Created ${gzipFileName} with ${gameCount} public games from ${fileStem}.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
