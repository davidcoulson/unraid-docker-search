<?PHP
/* docker.search: read-only container details that the Docker page does not show
 * (full image name, CPU pinning, labels, all networks), for the search box.
 *
 * MIT License. Copyright (c) 2026 David Coulson.
 */
$docroot ??= ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');

const DS_MAX_LABELS = 64;     // per container
const DS_MAX_KEY    = 128;    // characters
const DS_MAX_VALUE  = 200;    // characters

function ds_reply($code, $body) {
  if (PHP_SAPI !== 'cli') {
    http_response_code($code);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
  }
  echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
  exit;
}

// DockerClient echoes its own error text when the Docker socket is unavailable; keep that
// out of the JSON.
ob_start();
try {
  require_once "$docroot/plugins/dynamix.docker.manager/include/DockerClient.php";
  $client = new DockerClient();

  // Labels come from the list call; getDockerContainers() drops most of them.
  $labels = [];
  $list = $client->getDockerJSON('/containers/json?all=1');
  foreach (is_array($list) ? $list : [] as $ct) {
    if (!is_array($ct) || empty($ct['Id']) || !is_string($ct['Id'])) continue;
    $labels[substr(str_replace('sha256:', '', $ct['Id']), 0, 12)] = is_array($ct['Labels'] ?? null) ? $ct['Labels'] : [];
  }

  $out = [];
  $containers = $client->getDockerContainers();
  foreach (is_array($containers) ? $containers : [] as $ct) {
    if (!is_array($ct) || empty($ct['Id'])) continue;
    $id = (string)$ct['Id'];
    $l = [];
    foreach ($labels[$id] ?? [] as $k => $v) {
      if (count($l) >= DS_MAX_LABELS) break;
      $l[mb_substr((string)$k, 0, DS_MAX_KEY)] = mb_substr(is_scalar($v) ? (string)$v : '', 0, DS_MAX_VALUE);
    }
    $nets = [];
    foreach (is_array($ct['Networks'] ?? null) ? $ct['Networks'] : [] as $name => $net) {
      $nets[(string)$name] = (string)(is_array($net) ? ($net['IPAddress'] ?? '') : '');
    }
    $out[] = [
      'id'          => $id,
      'name'        => (string)($ct['Name'] ?? ''),
      'image'       => (string)($ct['Image'] ?? ''),
      'status'      => (string)($ct['Status'] ?? ''),
      'running'     => !empty($ct['Running']),
      'paused'      => !empty($ct['Paused']),
      'networkMode' => (string)($ct['NetworkMode'] ?? ''),
      'networks'    => (object)$nets,
      'cpuset'      => (string)($ct['CPUset'] ?? ''),
      'manager'     => (string)($ct['Manager'] ?: ''),
      'compose'     => (string)($ct['ComposeProject'] ?? ''),
      'webui'       => (string)($ct['Url'] ?: ''),
      'labels'      => (object)$l,
    ];
  }
  $noise = trim((string)ob_get_clean());
  if (!$out && $noise !== '') ds_reply(503, ['error' => 'docker unavailable', 'containers' => []]);
  ds_reply(200, ['containers' => $out]);
} catch (Throwable $e) {
  ob_end_clean();
  ds_reply(500, ['error' => 'failed to read containers', 'containers' => []]);
}
