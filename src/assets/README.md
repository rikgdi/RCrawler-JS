# Protocol Assets

Each subdirectory in `src/assets/` is named after a protocol version, for example:

- `src/assets/763` for Minecraft `1.20.1`
- `src/assets/770` for Minecraft `1.21.5`
- `src/assets/771` for Minecraft `1.21.6`
- `src/assets/772` for Minecraft `1.21.8`
- `src/assets/773` for Minecraft `1.21.9` and `1.21.10`
- `src/assets/774` for Minecraft `1.21.11`

Each protocol directory contains:

- `blocks.json`: block-state palette information from Mojang data reports
- `packets.json`: normalized packet id mappings used by the runtime
- `registries.json`: generated registry data from the server jar
- `metadata.json`: the protocol version, Minecraft version, and DataVersion

Regenerate a directory with:

```bash
node src/generate_protocol_assets.js --minecraft-version <mc-version> --protocol <protocol>
```

Examples:

```bash
node src/generate_protocol_assets.js --minecraft-version 1.20.1 --protocol 763
node src/generate_protocol_assets.js --minecraft-version 1.21.5 --protocol 770
node src/generate_protocol_assets.js --minecraft-version 1.21.6 --protocol 771
node src/generate_protocol_assets.js --minecraft-version 1.21.8 --protocol 772
node src/generate_protocol_assets.js --minecraft-version 1.21.9 --protocol 773
node src/generate_protocol_assets.js --minecraft-version 1.21.11 --protocol 774
```
