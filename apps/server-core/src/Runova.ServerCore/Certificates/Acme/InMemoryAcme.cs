using System.Collections.Concurrent;

namespace Runova.ServerCore.Certificates.Acme;

// In-memory stand-ins for the stores and challenge handlers, for tests and the DevHost. They copy
// what they are given (keys as PKCS#8 bytes), so they behave like a real store: whatever comes
// back is a new object the caller owns.

internal sealed class InMemoryAcmeAccountStore : IAcmeAccountStore
{
    private readonly ConcurrentDictionary<string, Saved> _accounts = new(StringComparer.Ordinal);

    public Task<AcmeAccount?> FindAsync(Uri directoryUrl, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(directoryUrl);
        cancellationToken.ThrowIfCancellationRequested();
        AcmeAccount? account = _accounts.TryGetValue(directoryUrl.AbsoluteUri, out var saved)
            ? new AcmeAccount(saved.DirectoryUrl, saved.Url, AcmeAccountKey.FromPkcs8(saved.Key))
            {
                Status = saved.Status,
                Contact = saved.Contact,
            }
            : null;
        return Task.FromResult(account);
    }

    public Task SaveAsync(AcmeAccount account, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(account);
        cancellationToken.ThrowIfCancellationRequested();
        _accounts[account.DirectoryUrl.AbsoluteUri] =
            new Saved(account.DirectoryUrl, account.Url, account.Key.ExportPkcs8(), account.Status, account.Contact);
        return Task.CompletedTask;
    }

    private sealed record Saved(Uri DirectoryUrl, Uri Url, byte[] Key, AcmeStatus Status, IReadOnlyList<string> Contact);
}

internal sealed class InMemoryAcmeCertificateStore : IAcmeCertificateStore
{
    private readonly ConcurrentDictionary<string, AcmeCertificateRecord> _records = new(StringComparer.Ordinal);

    public Task<AcmeCertificateRecord?> FindAsync(string name, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(name);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(_records.TryGetValue(name, out var record) ? record : null);
    }

    public Task SaveAsync(AcmeCertificateRecord record, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(record);
        cancellationToken.ThrowIfCancellationRequested();
        _records[record.Name] = record;
        return Task.CompletedTask;
    }
}

/// <summary>Keeps HTTP-01 answers in memory; a fake CA reads them back with <see cref="Find"/>.</summary>
internal sealed class InMemoryHttp01ChallengePublisher : IHttp01ChallengePublisher
{
    private readonly ConcurrentDictionary<(string Domain, string Token), string> _answers = new();

    public int Count => _answers.Count;

    /// <summary>What a GET of the challenge URL on this domain would return, or null.</summary>
    public string? Find(string domain, string token) => _answers.TryGetValue((domain, token), out var answer) ? answer : null;

    public Task PublishAsync(string domain, string token, string keyAuthorization, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _answers[(domain, token)] = keyAuthorization;
        return Task.CompletedTask;
    }

    public Task RemoveAsync(string domain, string token, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _answers.TryRemove((domain, token), out _);
        return Task.CompletedTask;
    }
}

/// <summary>Keeps DNS-01 TXT records in memory; a fake CA reads them back with <see cref="Find"/>.</summary>
internal sealed class InMemoryDns01ChallengeHook : IDns01ChallengeHook
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, List<string>> _records = new(StringComparer.OrdinalIgnoreCase);

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _records.Values.Sum(values => values.Count);
            }
        }
    }

    /// <summary>The TXT values a lookup of the record name would return.</summary>
    public IReadOnlyList<string> Find(string recordName)
    {
        lock (_gate)
        {
            return _records.TryGetValue(recordName, out var values) ? [.. values] : [];
        }
    }

    public Task PublishAsync(string domain, string recordName, string value, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (!_records.TryGetValue(recordName, out var values))
            {
                _records[recordName] = values = [];
            }

            values.Add(value);
        }

        return Task.CompletedTask;
    }

    public Task RemoveAsync(string domain, string recordName, string value, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_records.TryGetValue(recordName, out var values) && values.Remove(value) && values.Count == 0)
            {
                _records.Remove(recordName);
            }
        }

        return Task.CompletedTask;
    }
}
