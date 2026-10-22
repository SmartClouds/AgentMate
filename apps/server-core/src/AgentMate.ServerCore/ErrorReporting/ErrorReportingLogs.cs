using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using AgentMate.ServerCore.Security;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Resources;

namespace AgentMate.ServerCore.ErrorReporting;

/// <summary>
/// The core's warnings and errors, on their way to Sentry as OpenTelemetry logs. This is a logger
/// provider the host plugs in next to the console: every logger it hands out forwards to whichever
/// pipeline is live right now, so turning reporting on, off or to another project, or changing the
/// level or environment, takes effect at once and never needs a restart.
///
/// A pipeline is a real OpenTelemetry logger provider with an OTLP/HTTP exporter pointed at the DSN's
/// project. Before anything reaches it the message, every value and the exception are scrubbed with
/// the <see cref="Redactor"/>, so secrets stay on the server. The exporter's own logs (and the HTTP
/// client's) are never forwarded: a Sentry that is down would otherwise report its own failure to itself.
/// </summary>
internal sealed class ErrorReportingLogs(IErrorReportingTransport transport, Redactor redactor, string version, TimeProvider time) : ILoggerProvider
{
    /// <summary>Categories never forwarded: the exporter's own, so a failing Sentry cannot feed itself.</summary>
    private static readonly string[] _neverForwarded = ["OpenTelemetry", "System.Net.Http", "AgentMate.ServerCore.ErrorReporting"];

    private readonly Lock _gate = new();

    private readonly List<Task> _retiring = [];

    private volatile Pipeline? _pipeline;

    private bool _disposed;

    /// <summary>Whether logs are being forwarded right now.</summary>
    public bool IsReporting => _pipeline is not null;

    /// <summary>How sending is going for the live pipeline; empty when there is none.</summary>
    public ErrorDelivery Delivery => _pipeline?.Tracker.Snapshot() ?? ErrorDelivery.None;

    /// <summary>
    /// Starts reporting with this setup, replacing the live pipeline. Null, or a setup that is paused,
    /// stops it. Records the old pipeline still held are sent in the background before it closes.
    /// </summary>
    public void Apply(ErrorReportingConfig? config)
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            var old = _pipeline;
            _pipeline = config is { Enabled: true } ? new Pipeline(config, transport, version, time) : null;
            if (old is not null)
            {
                _retiring.RemoveAll(task => task.IsCompleted);
                _retiring.Add(Task.Run(old.Dispose));
            }
        }
    }

    /// <summary>Sends what is waiting; false if Sentry took longer than the timeout.</summary>
    public bool Flush(int timeoutMilliseconds) => _pipeline?.Batch.ForceFlush(timeoutMilliseconds) ?? true;

    public ILogger CreateLogger(string categoryName)
    {
        ArgumentNullException.ThrowIfNull(categoryName);
        return new Forwarder(categoryName, this);
    }

    public void Dispose()
    {
        Task[] retiring;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _pipeline?.Dispose();
            _pipeline = null;
            retiring = [.. _retiring];
        }

        Task.WaitAll(retiring, TimeSpan.FromSeconds(10));
    }

    private static bool IsForwarded(string category) =>
        !_neverForwarded.Any(prefix => category.StartsWith(prefix, StringComparison.Ordinal));

    /// <summary>The redactor, also masking these exact values (the ones logged under secret-like names).</summary>
    private Redactor ScrubberFor(string[] secrets) => secrets.Length == 0 ? redactor : redactor.With(secrets);

    /// <summary>Numbers and flags pass as they are; text under a secret-like name is hidden whole.</summary>
    private static object? Scrub(Redactor scrubber, string name, object? value) => value switch
    {
        null => null,
        string text => Redactor.IsSecretName(name) ? Redactor.Mask : scrubber.Redact(text),
        bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal => value,
        _ => scrubber.Redact(Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty),
    };

    private sealed class Forwarder(string category, ErrorReportingLogs owner) : ILogger
    {
        private readonly bool _forwarded = IsForwarded(category);

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) =>
            _forwarded && owner._pipeline is { } pipeline && pipeline.Level.Allows(logLevel);

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel) || owner._pipeline is not { } pipeline)
            {
                return;
            }

            try
            {
                var pairs = state as IEnumerable<KeyValuePair<string, object?>> ?? [];
                // A value logged under a secret-looking name ("{Password}") also lands in the message
                // text, so it is masked wherever it shows up in this call, not just as an attribute.
                var secrets = pairs
                    .Where(pair => pair.Value is string && Redactor.IsSecretName(pair.Key))
                    .Select(pair => (string)pair.Value!)
                    .ToArray();
                var scrubber = owner.ScrubberFor(secrets);

                var message = scrubber.Redact(formatter(state, exception));
                var attributes = new List<KeyValuePair<string, object?>>();
                foreach (var (name, value) in pairs)
                {
                    attributes.Add(new(name, Scrub(scrubber, name, value)));
                }

                if (exception is not null)
                {
                    attributes.Add(new("exception.type", exception.GetType().FullName));
                    attributes.Add(new("exception.message", scrubber.Redact(exception.Message)));
                    attributes.Add(new("exception.stacktrace", scrubber.Redact(exception.ToString())));
                }

                pipeline.Logger(category).Log(logLevel, eventId, new Scrubbed(message, attributes), null, static (scrubbed, _) => scrubbed.ToString());
            }
#pragma warning disable CA1031 // Reporting is best effort: a problem here must never reach the code that logged.
            catch (Exception)
#pragma warning restore CA1031
            {
            }
        }
    }

    /// <summary>A log call after scrubbing: the final message and its attributes, in the shape OpenTelemetry reads.</summary>
    private sealed class Scrubbed(string message, List<KeyValuePair<string, object?>> attributes) : IReadOnlyList<KeyValuePair<string, object?>>
    {
        public int Count => attributes.Count;

        public KeyValuePair<string, object?> this[int index] => attributes[index];

        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => attributes.GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        public override string ToString() => message;
    }

    /// <summary>One live OpenTelemetry logger provider with its exporter and delivery record.</summary>
    private sealed class Pipeline : IDisposable
    {
        private const int ExportTimeoutMilliseconds = 10_000;

        private const int BatchDelayMilliseconds = 2_000;

        private readonly ServiceProvider _services;

        private readonly ILoggerFactory _factory;

        private readonly ConcurrentDictionary<string, ILogger> _loggers = new(StringComparer.Ordinal);

        public Pipeline(ErrorReportingConfig config, IErrorReportingTransport transport, string version, TimeProvider time)
        {
            Level = config.MinLevel;
            Tracker = new DeliveryTracker(time, config.Dsn.Authority);
            var handler = new SentryDeliveryHandler(config.Dsn, Tracker, transport.CreateHandler());
            var exporter = new OtlpLogExporter(new OtlpExporterOptions
            {
                Endpoint = config.Dsn.LogsUri,
                Protocol = OtlpExportProtocol.HttpProtobuf,
                TimeoutMilliseconds = ExportTimeoutMilliseconds,
                HttpClientFactory = () => new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(ExportTimeoutMilliseconds) },
            });
            Batch = new BatchLogRecordExportProcessor(exporter, scheduledDelayMilliseconds: BatchDelayMilliseconds);

            var services = new ServiceCollection();
            services.AddLogging(logging => logging.AddOpenTelemetry(options =>
            {
                options.IncludeFormattedMessage = true;
                options.IncludeScopes = false;
                options.ParseStateValues = true;
                options.SetResourceBuilder(ResourceBuilder.CreateEmpty()
                    .AddService("agentmate-core", serviceVersion: version, autoGenerateServiceInstanceId: false)
                    .AddAttributes(
                    [
                        new KeyValuePair<string, object>("deployment.environment.name", config.Environment),
                        new KeyValuePair<string, object>("host.name", config.ServerName),
                    ]));
                options.AddProcessor(Batch);
            }));
            _services = services.BuildServiceProvider();
            _factory = _services.GetRequiredService<ILoggerFactory>();
        }

        public ReportingLevel Level { get; }

        public DeliveryTracker Tracker { get; }

        public BatchLogRecordExportProcessor Batch { get; }

        public ILogger Logger(string category) => _loggers.GetOrAdd(category, static (name, factory) => factory.CreateLogger(name), _factory);

        /// <summary>Sends what is waiting, then closes the exporter.</summary>
        public void Dispose() => _services.Dispose();
    }
}
