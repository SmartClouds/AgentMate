using System.Globalization;
using System.Text;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// A pretend server with nginx, in memory: files and symlinks, a master process whose workers are
/// replaced on every reload, and the commands the web module runs. The DevHost uses it so the UI
/// can be built on any OS, and the unit tests use it to drive apply, rollback and recovery through
/// every path, failures included. It never touches the real machine.
/// </summary>
internal sealed class SimulatedNginxMachine : INginxMachine
{
    public const string NginxConf = "/etc/nginx/nginx.conf";
    public const string PidFile = "/run/nginx.pid";
    public const int MasterPid = 4100;

    /// <summary>nginx.org's own nginx.conf, which the package installs.</summary>
    public const string StockNginxConf = """
        user  nginx;
        worker_processes  auto;

        error_log  /var/log/nginx/error.log notice;
        pid        /run/nginx.pid;

        events {
            worker_connections  1024;
        }

        http {
            include       /etc/nginx/mime.types;
            default_type  application/octet-stream;
            sendfile        on;
            keepalive_timeout  65;
            include /etc/nginx/conf.d/*.conf;
        }

        """;

    private readonly Lock _gate = new();
    private readonly Dictionary<string, byte[]> _files = new(StringComparer.Ordinal);
    private readonly Dictionary<string, UnixFileMode> _modes = new(StringComparer.Ordinal);
    private readonly HashSet<string> _directories = new(StringComparer.Ordinal) { "/" };
    private readonly Dictionary<string, string> _links = new(StringComparer.Ordinal);
    private readonly List<string> _commands = [];
    private readonly Queue<(DateTimeOffset At, string Text)> _retryLines = new();
    private int _nextPid = MasterPid + 1;
    private bool _pendingReload;
    private bool _advancing;

    /// <param name="installed">Start with nginx.org's nginx installed and running.</param>
    public SimulatedNginxMachine(bool installed = true)
    {
        WriteText("/proc/net/if_inet6", "00000000000000000000000000000001 01 80 10 80       lo\n");
        if (installed)
        {
            InstallPackage();
            Start();
        }
    }

    public bool Installed { get; private set; }

    public bool Running { get; private set; }

    public string Version { get; set; } = "1.30.0";

    public bool SeLinux
    {
        get => Exists("/sys/fs/selinux/enforce");
        set
        {
            if (value)
            {
                WriteText("/sys/fs/selinux/enforce", "1\n");
            }
            else
            {
                Remove("/sys/fs/selinux/enforce");
            }
        }
    }

    /// <summary>What nginx -t says about the configuration now in place; null means it passes.</summary>
    public Func<SimulatedNginxMachine, string?>? TestFailure { get; set; }

    /// <summary>What error.log gets when a reload is refused (a port in use, say); null means reloads work.</summary>
    public Func<SimulatedNginxMachine, string?>? ReloadFailure { get; set; }

    /// <summary>
    /// Refused reloads the way nginx refuses a port in use: the master tries bind() this many more
    /// times, <see cref="BindRetryInterval"/> apart, writing the failure each time, and then says
    /// it gives up. A reload signalled meanwhile waits until it has. Zero refuses at once.
    /// </summary>
    public int BindRetries { get; set; }

    public TimeSpan BindRetryInterval { get; set; } = TimeSpan.FromMilliseconds(500);

    public TimeProvider Clock { get; init; } = TimeProvider.System;

    /// <summary>Called before each command; a result answers it instead of the simulation.</summary>
    public Func<ProcessSpec, ProcessResult?>? Intercept { get; set; }

    /// <summary>Every command run, as "program arg arg", in order.</summary>
    public IReadOnlyList<string> Commands
    {
        get
        {
            lock (_gate)
            {
                return [.. _commands];
            }
        }
    }

    public int Reloads { get; private set; }

    public IReadOnlyList<int> Workers { get; private set; } = [];

    public UnixFileMode? ModeOf(string path)
    {
        lock (_gate)
        {
            return _modes.TryGetValue(Resolve(path), out var mode) ? mode : null;
        }
    }

    public string? Text(string path) => ReadTextAsync(path, CancellationToken.None).GetAwaiter().GetResult();

    public void WriteText(string path, string text, UnixFileMode mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead) =>
        WriteAsync(path, Encoding.UTF8.GetBytes(text), mode, CancellationToken.None).GetAwaiter().GetResult();

    public void AppendText(string path, string text) => WriteText(path, (Text(path) ?? string.Empty) + text);

    public bool Exists(string path) => ExistsAsync(path, CancellationToken.None).GetAwaiter().GetResult();

    public void Remove(string path) => DeleteAsync(path, CancellationToken.None).GetAwaiter().GetResult();

    public Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            Advance();
            return Task.FromResult(_files.TryGetValue(Resolve(path), out var bytes) ? Encoding.UTF8.GetString(bytes) : null);
        }
    }

    public Task WriteAsync(string path, ReadOnlyMemory<byte> content, UnixFileMode mode, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            var target = Resolve(path);
            AddDirectory(Parent(target));
            _files[target] = content.ToArray();
            _modes[target] = mode;
        }

        return Task.CompletedTask;
    }

    public Task<bool> ExistsAsync(string path, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            var resolved = Resolve(path);
            return Task.FromResult(_files.ContainsKey(resolved) || _directories.Contains(resolved) || _links.ContainsKey(Normalize(path)));
        }
    }

    public Task DeleteAsync(string path, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            var exact = Normalize(path);
            if (_links.Remove(exact))
            {
                return Task.CompletedTask;
            }

            var resolved = Resolve(path);
            _files.Remove(resolved);
            _modes.Remove(resolved);
            if (_directories.Remove(resolved))
            {
                var prefix = resolved + "/";
                foreach (var key in _files.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal)).ToList())
                {
                    _files.Remove(key);
                    _modes.Remove(key);
                }

                _directories.RemoveWhere(directory => directory.StartsWith(prefix, StringComparison.Ordinal));
                foreach (var key in _links.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal)).ToList())
                {
                    _links.Remove(key);
                }
            }
        }

        return Task.CompletedTask;
    }

    public Task CreateDirectoryAsync(string path, UnixFileMode mode, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            var resolved = Resolve(path);
            AddDirectory(resolved);
            _modes[resolved] = mode;
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<string>> ListAsync(string path, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            var prefix = Resolve(path).TrimEnd('/') + "/";
            IReadOnlyList<string> names = _files.Keys.Concat(_directories).Concat(_links.Keys)
                .Where(entry => entry.StartsWith(prefix, StringComparison.Ordinal) && entry.Length > prefix.Length && !entry[prefix.Length..].Contains('/', StringComparison.Ordinal))
                .Select(entry => entry[prefix.Length..])
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToList();
            return Task.FromResult(names);
        }
    }

    public Task<string?> ReadLinkAsync(string path, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            return Task.FromResult(_links.TryGetValue(Normalize(path), out var target) ? target : null);
        }
    }

    public Task ReplaceLinkAsync(string path, string target, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            _links[Normalize(path)] = target;
        }

        return Task.CompletedTask;
    }

    public Task MoveAsync(string from, string to, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            var source = Normalize(from);
            var target = Normalize(to);
            if (_files.ContainsKey(target) || _directories.Contains(target) || _links.ContainsKey(target))
            {
                throw new IOException($"Could not move {from}: {to} is there already.");
            }

            if (MoveFailure?.Invoke(source) is { } failure)
            {
                throw new IOException(failure);
            }

            static string Moved(string key, string source, string target) =>
                key == source ? target : target + key[source.Length..];

            bool Inside(string key) => key == source || key.StartsWith(source + "/", StringComparison.Ordinal);
            if (!_files.ContainsKey(source) && !_directories.Contains(source) && !_links.ContainsKey(source))
            {
                throw new IOException($"Could not move {from}: it is not there.");
            }

            foreach (var key in _files.Keys.Where(Inside).ToList())
            {
                _files[Moved(key, source, target)] = _files[key];
                _files.Remove(key);
                if (_modes.Remove(key, out var mode))
                {
                    _modes[Moved(key, source, target)] = mode;
                }
            }

            foreach (var key in _directories.Where(Inside).ToList())
            {
                _directories.Remove(key);
                _directories.Add(Moved(key, source, target));
                if (_modes.Remove(key, out var mode))
                {
                    _modes[Moved(key, source, target)] = mode;
                }
            }

            foreach (var key in _links.Keys.Where(Inside).ToList())
            {
                _links[Moved(key, source, target)] = _links[key];
                _links.Remove(key);
            }

            AddDirectory(Parent(target));
        }

        return Task.CompletedTask;
    }

    /// <summary>A reason to refuse moving this path (as rename(2) can), or null to move it.</summary>
    public Func<string, string?>? MoveFailure { get; set; }

    public Task<long?> LengthAsync(string path, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            Advance();
            return Task.FromResult(_files.TryGetValue(Resolve(path), out var bytes) ? bytes.Length : (long?)null);
        }
    }

    public Task<byte[]> ReadRangeAsync(string path, long offset, int maxBytes, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            Advance();
            if (!_files.TryGetValue(Resolve(path), out var bytes))
            {
                throw new FileNotFoundException($"{path} does not exist.");
            }

            return Task.FromResult(offset >= bytes.Length ? [] : bytes[(int)offset..(int)Math.Min(bytes.Length, offset + maxBytes)]);
        }
    }

    public Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(spec);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(Simulate(spec, job: null));
    }

    public Task<ProcessResult> RunInUnitAsync(JobContext job, string step, string description, ProcessSpec spec, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(spec);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(Simulate(spec, job));
    }

    /// <summary>nginx.org's package: its nginx.conf, the stock default site and the folders it creates.</summary>
    public void InstallPackage()
    {
        Installed = true;
        WriteText(NginxConf, StockNginxConf);
        WriteText("/etc/nginx/conf.d/default.conf", "server {\n    listen 80;\n    server_name localhost;\n}\n");
        WriteText("/etc/nginx/mime.types", "types { text/html html; }\n");
        WriteText("/var/log/nginx/error.log", string.Empty);
        CreateDirectoryAsync("/var/cache/nginx", UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, CancellationToken.None).GetAwaiter().GetResult();
    }

    private ProcessResult Simulate(ProcessSpec spec, JobContext? job)
    {
        var program = Path.GetFileName(spec.Program);
        var line = string.Join(' ', [program, .. spec.Arguments]);
        lock (_gate)
        {
            Advance();
            _commands.Add(line);
        }

        if (Intercept?.Invoke(spec) is { } answer)
        {
            return answer;
        }

        job?.Log(line, Contracts.JobLogSource.Out);
        var arguments = spec.Arguments;
        switch (program)
        {
            case "nginx" when !Installed:
                throw new ProcessStartException("nginx is not installed (looked in /usr/sbin).");
            case "nginx" when arguments is ["-V"]:
                return Result(0, error: $"nginx version: nginx/{Version}\nbuilt by gcc 12.2.0\nconfigure arguments: --prefix=/etc/nginx --conf-path={NginxConf} --error-log-path=/var/log/nginx/error.log --pid-path={PidFile} --with-http_ssl_module --with-http_v2_module --with-stream --with-stream_ssl_module\n");
            case "nginx" when arguments is ["-v"]:
                return Result(0, error: $"nginx version: nginx/{Version}\n");
            case "nginx" when arguments is ["-t"]:
                return TestFailure?.Invoke(this) is { } failure
                    ? Result(1, error: failure + $"\nnginx: configuration file {NginxConf} test failed\n")
                    : Result(0, error: $"nginx: the configuration file {NginxConf} syntax is ok\nnginx: configuration file {NginxConf} test is successful\n");
            case "nginx" when arguments is ["-s", "reload"]:
                return Reload();
            case "systemctl" when arguments.Contains("start", StringComparer.Ordinal) || arguments.Contains("--now", StringComparer.Ordinal):
                Start();
                return Result(0);
            case "apt-get" or "dnf" when arguments.Contains("nginx", StringComparer.Ordinal) && arguments.Contains("install", StringComparer.Ordinal):
                InstallPackage();
                return Result(0, "Setting up nginx ...\n");
            case "getenforce":
                return Result(0, SeLinux ? "Enforcing\n" : "Disabled\n");
            default:
                return Result(0);
        }
    }

    private ProcessResult Reload()
    {
        if (!Running)
        {
            return Result(1, error: $"nginx: [error] open() \"{PidFile}\" failed (2: No such file or directory)\n");
        }

        Reloads++;
        lock (_gate)
        {
            Advance();
            if (_retryLines.Count > 0)
            {
                // The master is still busy with the last one; it takes this signal afterwards.
                _pendingReload = true;
                return Result(0);
            }

            TakeReload();
        }

        return Result(0);
    }

    private void TakeReload()
    {
        if (ReloadFailure?.Invoke(this) is not { } failure)
        {
            SpawnWorkers();
            return;
        }

        AppendLog($"2026/10/01 12:00:00 [notice] {MasterPid}#{MasterPid}: signal process started\n{failure}\n");
        if (BindRetries > 0)
        {
            var now = Clock.GetUtcNow();
            for (var retry = 1; retry <= BindRetries; retry++)
            {
                _retryLines.Enqueue((now + (BindRetryInterval * retry), failure + "\n"));
            }

            _retryLines.Enqueue((now + (BindRetryInterval * (BindRetries + 1)), $"2026/10/01 12:00:00 [emerg] {MasterPid}#{MasterPid}: still could not bind()\n"));
        }
    }

    /// <summary>Writes the retry lines that are due and, once a refused reload is over, takes the one signalled meanwhile.</summary>
    private void Advance()
    {
        if (_advancing || (_retryLines.Count == 0 && !_pendingReload))
        {
            return;
        }

        _advancing = true;
        try
        {
            var now = Clock.GetUtcNow();
            while (_retryLines.TryPeek(out var due) && due.At <= now)
            {
                AppendLog(_retryLines.Dequeue().Text);
            }

            if (_retryLines.Count == 0 && _pendingReload)
            {
                _pendingReload = false;
                TakeReload();
            }
        }
        finally
        {
            _advancing = false;
        }
    }

    private void AppendLog(string text)
    {
        var path = Resolve("/var/log/nginx/error.log");
        var before = _files.TryGetValue(path, out var bytes) ? bytes : [];
        _files[path] = [.. before, .. Encoding.UTF8.GetBytes(text)];
    }

    private void Start()
    {
        if (!Installed)
        {
            return;
        }

        Running = true;
        WriteText(PidFile, MasterPid.ToString(CultureInfo.InvariantCulture) + "\n");
        WriteText($"/proc/{MasterPid}/stat", $"{MasterPid} (nginx) S 1 {MasterPid}\n");
        SpawnWorkers();
    }

    private void SpawnWorkers()
    {
        Workers = [_nextPid++, _nextPid++];
        WriteText($"/proc/{MasterPid}/task/{MasterPid}/children", string.Join(' ', Workers) + " ");
    }

    private static ProcessResult Result(int exitCode, string output = "", string error = "") =>
        new(exitCode, output, error, TimedOut: false, OutputTruncated: false);

    private void AddDirectory(string path)
    {
        for (var current = path; current.Length > 0; current = Parent(current))
        {
            if (!_directories.Add(current) || current == "/")
            {
                break;
            }
        }
    }

    private static string Parent(string path)
    {
        var slash = path.LastIndexOf('/');
        return slash <= 0 ? "/" : path[..slash];
    }

    private static string Normalize(string path)
    {
        if (!path.StartsWith('/') || path.Split('/').Any(part => part is "." or ".."))
        {
            throw new ArgumentException("Paths on the server are absolute, without . or .. parts.", nameof(path));
        }

        return path.Length > 1 ? path.TrimEnd('/') : path;
    }

    /// <summary>The path with every symlink along it followed (relative targets from the link's folder).</summary>
    private string Resolve(string path)
    {
        var parts = Normalize(path).Split('/', StringSplitOptions.RemoveEmptyEntries);
        var current = string.Empty;
        for (var i = 0; i < parts.Length; i++)
        {
            current = current + "/" + parts[i];
            for (var hops = 0; _links.TryGetValue(current, out var target) && hops < 8; hops++)
            {
                current = target.StartsWith('/') ? target.TrimEnd('/') : Parent(current).TrimEnd('/') + "/" + target.TrimEnd('/');
            }
        }

        return current.Length == 0 ? "/" : current;
    }
}
