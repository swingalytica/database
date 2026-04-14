# RealGolf.Games Database

Monthly data dumps of public games from [RealGolf.Games](https://realgolf.games), published in [GGN format](https://github.com/swingalytica/ggn).

## Downloads

Dumps are published at [database.realgolf.games](https://database.realgolf.games) on the first of every month.

Each file contains all public games played up to that point, one game per line, compressed with gzip.

```
YYYY-MM.ggn.gz
```

## Format

Games are stored in GGN (Golf Game Notation) — an open format inspired by PGN. See the [GGN Specification](https://github.com/swingalytica/ggn) for full documentation.

## Parsing

Use the official CLI to work with GGN files:

```bash
pnpm add -g swingalytica
swingalytica ggn -i 2026-07.ggn
```

## License

- **Code** (export scripts, website) — [MIT](./LICENSE)
- **Data** (`.ggn.gz` dump files) — [CC BY 4.0](./LICENSE-DATA)

When using the data, attribution is required:

> Data provided by [RealGolf.Games](https://realgolf.games), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Links

- [RealGolf.Games](https://realgolf.games)
- [GGN Specification](https://github.com/swingalytica/ggn)
- [swingalytica CLI on npm](https://npmjs.com/package/swingalytica)
- [database.realgolf.games](https://database.realgolf.games)
