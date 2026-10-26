using System.Globalization;
using System.Text;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Docker;

/// <summary>
/// What the pretend engine starts with: a "shop" project (web, api, db, worker), a "monitoring"
/// project (grafana, prometheus, and a cloudflared tunnel whose distroless image has no shell), a
/// toolbox container and a one-off migration that has exited.
/// </summary>
internal sealed partial class InMemoryDockerEngine
{
    private const int HostCpus = 4;

    private void Seed()
    {
        var now = NowMs;
        var day = TimeSpan.FromDays(1).TotalMilliseconds;
        Image("nginx:1.29", 192_741_376, now - (long)(day * 12));
        Image("shop-api:latest", 238_612_480, now - (long)(day * 2));
        Image("postgres:17", 456_212_480, now - (long)(day * 20));
        Image("grafana/grafana:12.1.1", 734_003_200, now - (long)(day * 30));
        Image("prom/prometheus:v3.5.0", 313_524_224, now - (long)(day * 30));
        Image("debian:13", 120_586_240, now - (long)(day * 40));
        Image("cloudflare/cloudflared:2025.9.1", 63_401_984, now - (long)(day * 25));

        _networks.AddRange(
        [
            new("bridge", "172.17.0.0/16", null),
            new("host", null, null),
            new("none", null, null),
            new("shop_default", "172.20.0.0/16", "shop"),
            new("monitoring_default", "172.21.0.0/16", "monitoring"),
        ]);
        var anonymous = IdOf("anonymous-cache");
        _volumes.AddRange(
        [
            new("shop_db-data", now - (long)(day * 20), 512L * 1024 * 1024, "shop", Anonymous: false),
            new("shop_uploads", now - (long)(day * 20), 96L * 1024 * 1024, "shop", Anonymous: false),
            new("monitoring_prometheus-data", now - (long)(day * 30), 1_342_177_280, "monitoring", Anonymous: false),
            new(anonymous, now - (long)(day * 2), 4L * 1024 * 1024, null, Anonymous: true),
        ]);

        Add(new Container("shop-web-1", "nginx:1.29", "shop", "web", Kind.Nginx)
        {
            Ports = [new(80, "tcp", "127.0.0.1", 8080)],
            Environment = [new("NGINX_ENTRYPOINT_QUIET_LOGS", "1")],
            Mounts = [new("volume", "/var/cache/nginx", true, $"/var/lib/docker/volumes/{anonymous}/_data", anonymous), new("volume", "/srv/uploads", false, "/var/lib/docker/volumes/shop_uploads/_data", "shop_uploads")],
            Command = ["nginx", "-g", "daemon off;"],
            Health = ContainerHealth.Healthy,
            Load = 0.04,
            MemoryBase = 14L * 1024 * 1024,
        });
        Add(new Container("shop-api-1", "shop-api:latest", "shop", "api", Kind.Api)
        {
            Ports = [new(3000, "tcp")],
            Environment =
            [
                new("NODE_ENV", "production"),
                new("PORT", "3000"),
                new("DATABASE_URL", $"postgres://shop:{DatabasePassword}@db:5432/shop"),
                new("API_TOKEN", ApiToken),
            ],
            Mounts = [new("volume", "/srv/uploads", true, "/var/lib/docker/volumes/shop_uploads/_data", "shop_uploads")],
            Command = ["node", "server.js"],
            Health = ContainerHealth.Healthy,
            Load = 0.22,
            MemoryBase = 182L * 1024 * 1024,
            MemoryLimit = 512L * 1024 * 1024,
            NanoCpus = 1_500_000_000,
        });
        Add(new Container("shop-db-1", "postgres:17", "shop", "db", Kind.Postgres)
        {
            Ports = [new(5432, "tcp")],
            Environment = [new("POSTGRES_USER", "shop"), new("POSTGRES_DB", "shop"), new("POSTGRES_PASSWORD", DatabasePassword), new("PGDATA", "/var/lib/postgresql/data")],
            Mounts = [new("volume", "/var/lib/postgresql/data", true, "/var/lib/docker/volumes/shop_db-data/_data", "shop_db-data")],
            Command = ["postgres"],
            Health = ContainerHealth.Healthy,
            Load = 0.08,
            MemoryBase = 96L * 1024 * 1024,
        });
        Add(new Container("shop-worker-1", "shop-api:latest", "shop", "worker", Kind.Worker)
        {
            Environment = [new("NODE_ENV", "production"), new("QUEUE_URL", $"redis://worker:{ApiToken}@redis:6379/0")],
            Command = ["node", "worker.js"],
            Tty = true,
            Load = 0.11,
            MemoryBase = 121L * 1024 * 1024,
        });
        Add(new Container("monitoring-grafana-1", "grafana/grafana:12.1.1", "monitoring", "grafana", Kind.Grafana)
        {
            Ports = [new(3000, "tcp", "0.0.0.0", 3001), new(3000, "tcp", "::", 3001)],
            Environment = [new("GF_SECURITY_ADMIN_PASSWORD", "grafana-admin-91ac"), new("GF_SERVER_ROOT_URL", "https://grafana.example.com")],
            Command = ["/run.sh"],
            User = "472",
            Load = 0.03,
            MemoryBase = 88L * 1024 * 1024,
        });
        Add(new Container("monitoring-prometheus-1", "prom/prometheus:v3.5.0", "monitoring", "prometheus", Kind.Prometheus)
        {
            Ports = [new(9090, "tcp", "127.0.0.1", 9090)],
            Mounts = [new("volume", "/prometheus", true, "/var/lib/docker/volumes/monitoring_prometheus-data/_data", "monitoring_prometheus-data")],
            Command = ["/bin/prometheus", "--config.file=/etc/prometheus/prometheus.yml"],
            Load = 0.06,
            MemoryBase = 143L * 1024 * 1024,
        });
        Add(new Container(DistrolessContainer, "cloudflare/cloudflared:2025.9.1", "monitoring", "cloudflared", Kind.Tunnel)
        {
            Command = ["tunnel", "--no-autoupdate", "run"],
            User = "65532",
            Shell = false,
            Load = 0.01,
            MemoryBase = 24L * 1024 * 1024,
        });
        Add(new Container("toolbox", "debian:13", null, null, Kind.Quiet)
        {
            Command = ["sleep", "infinity"],
            Load = 0.0,
            MemoryBase = 1L * 1024 * 1024,
        });
        var migration = new Container("migrate-once", "shop-api:latest", null, null, Kind.Migration)
        {
            Environment = [new("DATABASE_URL", $"postgres://shop:{DatabasePassword}@db:5432/shop")],
            Command = ["node", "migrate.js"],
            Load = 0.0,
            MemoryBase = 0,
        };
        Add(migration);
        migration.Exit(now - (long)(day / 2), 0);
    }

    private void Image(string tag, long size, long created)
    {
        var repository = tag[..tag.LastIndexOf(':')];
        _images.Add(new ImageInfo("sha256:" + IdOf(tag), [tag], [$"{repository}@sha256:{IdOf(tag + "digest")}"], created, size, 0));
    }

    private void Add(Container container)
    {
        var started = NowMs - (long)TimeSpan.FromHours(30 + (_containers.Count * 7)).TotalMilliseconds;
        container.Created(started - 60_000);
        container.Start(started);
        container.CatchUp(_time.GetUtcNow());
        _containers.Add(container);
    }

    private enum Kind
    {
        Nginx,
        Api,
        Postgres,
        Worker,
        Grafana,
        Prometheus,
        Quiet,
        Migration,

        /// <summary>A distroless image: the binary and its certificates, no shell (E27).</summary>
        Tunnel,

        /// <summary>Exits a few seconds after each start and is restarted: a crash loop (E09, DevHost only).</summary>
        Crashing,
    }

    private sealed record LogEntry(long Sequence, long AtMs, ContainerLogSource Stream, string Text);

    /// <summary>One pretend container: its configuration, state, counters and log.</summary>
    private sealed class Container(string name, string image, string? project, string? service, Kind kind)
    {
        private const int HistoryLimit = 2_000;

        private ulong _cpu;
        private ulong _system;
        private ulong _received;
        private ulong _transmitted;
        private ulong _read;
        private ulong _written;
        private DateTimeOffset _lastRead;
        private long _lastLogMs;
        private long _createdMs;
        private long _startedMs;
        private long? _finishedMs;

        public string Id { get; } = IdOf("container:" + name);

        public Kind Kind => kind;

        /// <summary>False for a distroless image: an exec finds no sh, stat or anything else.</summary>
        public bool Shell { get; init; } = true;

        /// <summary>The image's USER, or null for root.</summary>
        public string? User { get; init; }

        public string Name { get; } = name;

        public string Image { get; } = image;

        public string ImageId { get; } = "sha256:" + IdOf(image);

        public ContainerState State { get; set; } = ContainerState.Created;

        public int ExitCode { get; private set; }

        public int RestartCount { get; set; }

        public IReadOnlyList<ContainerPort> Ports { get; init; } = [];

        public IReadOnlyList<KeyValuePair<string, string>> Environment { get; init; } = [];

        public IReadOnlyList<ContainerMount> Mounts { get; init; } = [];

        public IReadOnlyList<string> Command { get; init; } = [];

        public IReadOnlyList<string> Networks { get; } = [project is null ? "bridge" : $"{project}_default"];

        public bool Tty { get; init; }

        public ContainerHealth Health { get; init; }

        public double Load { get; init; }

        public long MemoryBase { get; init; }

        public long? MemoryLimit { get; init; }

        public long? NanoCpus { get; init; }

        public IReadOnlyDictionary<string, string> Labels { get; } = project is null
            ? new Dictionary<string, string>(StringComparer.Ordinal)
            : new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["com.docker.compose.project"] = project,
                ["com.docker.compose.service"] = service!,
                ["com.docker.compose.container-number"] = "1",
                ["com.docker.compose.oneoff"] = "False",
                ["com.docker.compose.project.working_dir"] = $"/srv/apps/{project}",
                ["com.docker.compose.project.config_files"] = $"/srv/apps/{project}/compose.yaml",
                ["com.docker.compose.image"] = "sha256:" + IdOf(image),
            };

        public List<LogEntry> Log { get; } = [];

        public long LastSequence { get; private set; }

        public void Created(long at) => _createdMs = at;

        public void Start(long at)
        {
            State = ContainerState.Running;
            _startedMs = at;
            _finishedMs = null;
            _lastLogMs = Math.Max(_lastLogMs, at);
            _lastRead = DateTimeOffset.FromUnixTimeMilliseconds(at);
            Append(at, ContainerLogSource.Stdout, kind == Kind.Postgres ? "LOG:  database system is ready to accept connections" : $"{Name} started");
        }

        public void Exit(long at, int code)
        {
            CatchUp(DateTimeOffset.FromUnixTimeMilliseconds(at));
            if (kind == Kind.Migration)
            {
                Append(at - 1200, ContainerLogSource.Stdout, "Applying migration 0042_orders_customer_index");
                Append(at - 400, ContainerLogSource.Stdout, "Migrations are up to date.");
            }

            State = ContainerState.Exited;
            ExitCode = code;
            _finishedMs = at;
        }

        public ContainerSummary Summary(long now) => new(
            Id,
            Name,
            Image,
            ImageId,
            State,
            Status(now),
            State == ContainerState.Running ? Health : ContainerHealth.None,
            _createdMs,
            [.. Ports],
            project,
            service,
            project is null ? null : 1);

        public ContainerDetails Details(long now) => new(
            Summary(now),
            [.. Command],
            [],
            [.. Environment.Select(entry => entry.Key)],
            [.. Labels.OrderBy(label => label.Key, StringComparer.Ordinal).Select(label => new ContainerLabel(label.Key, label.Value))],
            [.. Mounts],
            [.. Networks.Select((network, index) => new ContainerNetwork(network, $"172.{(project == "monitoring" ? 21 : project == "shop" ? 20 : 17)}.0.{index + 2 + (int)(Id[0] % 50)}", null, "02:42:ac:14:00:0" + (Id[1] % 9).ToString(CultureInfo.InvariantCulture)))],
            project is null ? "no" : "unless-stopped",
            RestartCount,
            Tty,
            false,
            false,
            User,
            kind == Kind.Api || kind == Kind.Worker || kind == Kind.Migration ? "/srv/app" : null,
            Id[..12],
            _startedMs,
            State == ContainerState.Running ? null : _finishedMs,
            State == ContainerState.Running ? null : ExitCode,
            null,
            MemoryLimit,
            NanoCpus is long nano ? nano / 1e9 : null);

        public StatsReading Read(DateTimeOffset now)
        {
            var preCpu = _cpu;
            var preSystem = _system;
            var seconds = Math.Max(0.001, (now - _lastRead).TotalSeconds);
            _lastRead = now;
            var t = now.ToUnixTimeMilliseconds() / 1000.0;
            var phase = Id[2] % 17;
            var busy = Math.Max(0, Load * (1 + (0.6 * Math.Sin((t / 23) + phase)) + (0.25 * Math.Sin((t / 5.3) + phase))));
            _cpu += (ulong)(seconds * busy * 1e9);
            _system += (ulong)(seconds * HostCpus * 1e9);
            var traffic = kind is Kind.Quiet ? 0 : Load * 4e5;
            _received += (ulong)(seconds * traffic * (1.2 + Math.Sin(t / 30)));
            _transmitted += (ulong)(seconds * traffic * 0.6 * (1.2 + Math.Cos(t / 25)));
            _read += (ulong)(seconds * (kind == Kind.Postgres ? 9e4 : 1e3));
            _written += (ulong)(seconds * (kind is Kind.Postgres or Kind.Prometheus ? 2.2e5 : 2e3));
            var memory = (ulong)(MemoryBase * (1 + (0.06 * Math.Sin((t / 90) + phase))));
            var inactive = memory / 9;
            return new StatsReading(
                now,
                _cpu,
                preCpu,
                _system,
                preSystem,
                HostCpus,
                HostCpus,
                memory + inactive,
                (ulong)(MemoryLimit ?? 8 * Gigabyte),
                new Dictionary<string, ulong>(StringComparer.Ordinal) { ["inactive_file"] = inactive, ["anon"] = memory },
                [new BlockIoEntry("read", _read), new BlockIoEntry("write", _written)],
                [new NetworkTotals(_received, _transmitted)],
                kind switch { Kind.Postgres => 9, Kind.Api => 11, Kind.Nginx => 5, Kind.Quiet => 1, _ => 7 });
        }

        /// <summary>Writes the log lines a running container would have written since the last look.</summary>
        public void CatchUp(DateTimeOffset now)
        {
            var crashing = kind == Kind.Crashing && State == ContainerState.Restarting;
            if ((State != ContainerState.Running && !crashing) || kind is Kind.Quiet or Kind.Migration)
            {
                return;
            }

            var until = now.ToUnixTimeMilliseconds();
            var from = Math.Max(_lastLogMs, until - (HistoryLimit * 1000L));
            for (var at = from + 1000; at <= until; at += 1000)
            {
                var n = (int)((at / 1000) % 100_000);
                foreach (var (stream, text) in Lines(n))
                {
                    Append(at, stream, text);
                }

                _lastLogMs = at;
            }
        }

        public LogChunk Chunk(LogEntry entry)
        {
            var at = DateTimeOffset.FromUnixTimeMilliseconds(entry.AtMs).UtcDateTime;
            var nanos = ((entry.AtMs % 1000) * 1_000_000) + (entry.Sequence % 1_000_000);
            var stamp = string.Create(CultureInfo.InvariantCulture, $"{at:yyyy-MM-ddTHH:mm:ss}.{nanos:D9}Z");
            var text = $"{stamp} {entry.Text}{(Tty ? "\r\n" : "\n")}";
            return new LogChunk(Tty ? ContainerLogSource.Stdout : entry.Stream, Encoding.UTF8.GetBytes(text));
        }

        private void Append(long at, ContainerLogSource stream, string text)
        {
            Log.Add(new LogEntry(++LastSequence, at, stream, text));
            if (Log.Count > HistoryLimit)
            {
                Log.RemoveRange(0, Log.Count - HistoryLimit);
            }
        }

        private IEnumerable<(ContainerLogSource Stream, string Text)> Lines(int n)
        {
            var at = DateTimeOffset.FromUnixTimeSeconds(n);
            switch (kind)
            {
                case Kind.Nginx:
                    yield return (ContainerLogSource.Stdout, $"172.20.0.1 - - [{at:dd/MMM/yyyy:HH:mm:ss} +0000] \"GET /products/{n % 240} HTTP/1.1\" 200 {5120 + (n % 900)} \"-\" \"Mozilla/5.0\"");
                    if (n % 11 == 0)
                    {
                        yield return (ContainerLogSource.Stderr, $"[error] 29#29: *{n} open() \"/usr/share/nginx/html/favicon.ico\" failed (2: No such file or directory)");
                    }

                    break;
                case Kind.Api:
                    yield return (ContainerLogSource.Stdout, $"info: GET /api/orders/{n % 500} 200 in {8 + (n % 40)}ms");
                    if (n % 7 == 0)
                    {
                        yield return (ContainerLogSource.Stderr, $"warn: retrying database connection postgres://shop:{DatabasePassword}@db:5432/shop (attempt {1 + (n % 3)})");
                    }

                    if (n % 13 == 0)
                    {
                        yield return (ContainerLogSource.Stderr, "error: payment provider timed out after 3000ms");
                    }

                    break;
                case Kind.Postgres:
                    if (n % 5 == 0)
                    {
                        yield return (ContainerLogSource.Stderr, $"LOG:  checkpoint complete: wrote {n % 60} buffers ({(n % 60) / 10.0:0.0}%)");
                    }

                    break;
                case Kind.Worker:
                    yield return (ContainerLogSource.Stdout, $"processed job {n} in {40 + (n % 200)}ms");
                    break;
                case Kind.Grafana:
                    if (n % 3 == 0)
                    {
                        yield return (ContainerLogSource.Stdout, "logger=context level=info msg=\"Request Completed\" method=GET path=/api/health status=200");
                    }

                    break;
                case Kind.Crashing when n % 5 == 0:
                    yield return (ContainerLogSource.Stdout, "mailer: connecting to smtp.internal:587");
                    yield return (ContainerLogSource.Stderr, "Error: connect ECONNREFUSED 10.0.4.12:587");
                    yield return (ContainerLogSource.Stderr, "mailer exited with code 1");
                    break;
                case Kind.Prometheus:
                    if (n % 4 == 0)
                    {
                        yield return (ContainerLogSource.Stderr, "level=info component=tsdb msg=\"Head GC completed\" duration=2.1ms");
                    }

                    break;
                default:
                    break;
            }
        }

        private string Status(long now)
        {
            var since = (now - (State == ContainerState.Running || State == ContainerState.Paused ? _startedMs : _finishedMs ?? now)) / 1000;
            var ago = since switch
            {
                < 60 => $"{Math.Max(1, since)} seconds",
                < 3600 => $"{since / 60} minutes",
                < 172_800 => $"{since / 3600} hours",
                _ => $"{since / 86_400} days",
            };
            return State switch
            {
                ContainerState.Running => $"Up {ago}{(Health == ContainerHealth.Healthy ? " (healthy)" : string.Empty)}",
                ContainerState.Paused => $"Up {ago} (Paused)",
                ContainerState.Exited => $"Exited ({ExitCode}) {ago} ago",
                ContainerState.Created => "Created",
                ContainerState.Restarting => $"Restarting (1) {Math.Max(1, since % 9)} seconds ago",
                _ => State.ToString(),
            };
        }
    }
}
