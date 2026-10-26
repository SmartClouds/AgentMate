using System.Text.Json;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Jobs;

/// <summary>
/// Writes one job's log: one JSON line per log line, numbered from 1, in a file only root can read.
/// Text arrives already redacted. Past the size limit one last note says so and the rest is dropped,
/// so a chatty program cannot fill the disk.
/// </summary>
internal sealed class JobLogWriter : IDisposable
{
    private const string FullNotice = "The log reached its size limit; later output is not kept.";

    private readonly FileStream _file;
    private readonly long _maxBytes;
    private readonly TimeProvider _time;
    private readonly Action _appended;
    private readonly Lock _gate = new();
    private long _bytes;
    private bool _full;
    private bool _closed;

    private JobLogWriter(FileStream file, long maxBytes, TimeProvider time, Action appended)
    {
        _file = file;
        _maxBytes = maxBytes;
        _time = time;
        _appended = appended;
    }

    public long Count { get; private set; }

    public static JobLogWriter Create(string path, long maxBytes, TimeProvider time, Action appended)
    {
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.Read | FileShare.Delete,
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return new JobLogWriter(new FileStream(path, options), maxBytes, time, appended);
    }

    public void Append(JobLogSource source, string text)
    {
        lock (_gate)
        {
            if (_full || _closed)
            {
                return;
            }

            var line = Serialize(source, text);
            if (_bytes + line.Length > _maxBytes)
            {
                _full = true;
                line = Serialize(JobLogSource.System, FullNotice);
            }

            _file.Write(line);
            _file.Flush();
            _bytes += line.Length;
            Count++;
        }

        _appended();
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_closed)
            {
                return;
            }

            _closed = true;
            _file.Dispose();
        }
    }

    private byte[] Serialize(JobLogSource source, string text)
    {
        var line = new JobLogLine(Count + 1, _time.GetUtcNow().ToUnixTimeMilliseconds(), source, text);
        var json = JsonSerializer.SerializeToUtf8Bytes(line, CoreJson.Options);
        var bytes = new byte[json.Length + 1];
        json.CopyTo(bytes, 0);
        bytes[^1] = (byte)'\n';
        return bytes;
    }
}

/// <summary>
/// Reads a job's log while it may still grow: each call returns the complete lines written since
/// the last one. A line caught halfway through being written waits for the next call.
/// </summary>
internal sealed class JobLogReader : IDisposable
{
    private readonly FileStream? _file;
    private readonly byte[] _buffer = new byte[64 * 1024];
    private byte[] _partial = [];

    public JobLogReader(string path)
    {
        if (File.Exists(path))
        {
            _file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        }
    }

    public async Task<List<JobLogLine>> ReadNewAsync(CancellationToken cancellationToken)
    {
        var lines = new List<JobLogLine>();
        if (_file is null)
        {
            return lines;
        }

        int read;
        while ((read = await _file.ReadAsync(_buffer, cancellationToken)) > 0)
        {
            var data = _partial.Length == 0 ? _buffer.AsSpan(0, read).ToArray() : [.. _partial, .. _buffer.AsSpan(0, read)];
            var start = 0;
            for (var i = 0; i < data.Length; i++)
            {
                if (data[i] != (byte)'\n')
                {
                    continue;
                }

                if (Parse(data.AsSpan(start, i - start)) is { } line)
                {
                    lines.Add(line);
                }

                start = i + 1;
            }

            _partial = data[start..];
        }

        return lines;
    }

    public void Dispose() => _file?.Dispose();

    private static JobLogLine? Parse(ReadOnlySpan<byte> json)
    {
        try
        {
            return JsonSerializer.Deserialize<JobLogLine>(json, CoreJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
