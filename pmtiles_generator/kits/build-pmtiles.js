// Kit partagé : assemble les FlatGeobuf produits par l'étape "convert" de
// n'importe quelle source en un PMTiles multi-couches via tippecanoe.
// Référencé par `uses: build-pmtiles` dans pipelines/<source>.yaml.
export default function () {
  return {
    image: 'ubuntu:latest',
    cmd: ['sh', '-c', 'bash /app/build.sh'],
    setup: {
      cmd: [
        'sh',
        '-c',
        'apt-get update && apt-get install -y --no-install-recommends tippecanoe && rm -rf /var/lib/apt/lists/*',
      ],
      caches: [{ name: 'apt-cache', path: '/var/cache/apt', exclusive: true }],
      allowNetwork: true,
    },
    mounts: [{ host: '../scripts/common/build.sh', container: '/app/build.sh' }],
  }
}
