namespace Runova.ServerCore.Uploads;

/// <summary>
/// An uploaded archive the core will not unpack. The message says why in words a person can act
/// on, and never repeats raw control characters from the archive, so it is safe to show and log.
/// </summary>
public sealed class ArchiveRejectedException : Exception
{
    public ArchiveRejectedException()
        : base("The archive was refused.")
    {
    }

    public ArchiveRejectedException(string message)
        : base(message)
    {
    }

    public ArchiveRejectedException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
