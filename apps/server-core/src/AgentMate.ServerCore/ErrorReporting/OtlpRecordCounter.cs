namespace AgentMate.ServerCore.ErrorReporting;

/// <summary>
/// Counts the log records in an OTLP export request, so "sent N events" is true. The exporter hides
/// how many records a batch held, and the layout is fixed by the OTLP specification:
/// ExportLogsServiceRequest.resource_logs (1) holds ResourceLogs.scope_logs (2), which holds
/// ScopeLogs.log_records (2). Anything that does not parse counts as nothing.
/// </summary>
internal static class OtlpRecordCounter
{
    private const int LengthDelimited = 2;

    public static int Count(ReadOnlySpan<byte> body)
    {
        var records = 0;
        foreach (var resource in Fields(body, 1))
        {
            foreach (var scope in Fields(resource, 2))
            {
                records += Fields(scope, 2).Count;
            }
        }

        return records;
    }

    /// <summary>The length-delimited fields with this number, as copies; stops quietly at bad data.</summary>
    private static List<byte[]> Fields(ReadOnlySpan<byte> message, int number)
    {
        var found = new List<byte[]>();
        var position = 0;
        while (position < message.Length)
        {
            if (!TryVarint(message, ref position, out var tag))
            {
                break;
            }

            var wire = (int)(tag & 7);
            var field = (int)(tag >> 3);
            if (wire == LengthDelimited)
            {
                if (!TryVarint(message, ref position, out var length) || length > (ulong)(message.Length - position))
                {
                    break;
                }

                if (field == number)
                {
                    found.Add(message.Slice(position, (int)length).ToArray());
                }

                position += (int)length;
            }
            else if (!TrySkip(message, ref position, wire))
            {
                break;
            }
        }

        return found;
    }

    private static bool TrySkip(ReadOnlySpan<byte> message, ref int position, int wire)
    {
        switch (wire)
        {
            case 0:
                return TryVarint(message, ref position, out _);
            case 1:
                return Advance(message, ref position, 8);
            case 5:
                return Advance(message, ref position, 4);
            default:
                return false;
        }
    }

    private static bool Advance(ReadOnlySpan<byte> message, ref int position, int count)
    {
        if (message.Length - position < count)
        {
            return false;
        }

        position += count;
        return true;
    }

    private static bool TryVarint(ReadOnlySpan<byte> message, ref int position, out ulong value)
    {
        value = 0;
        for (var shift = 0; shift < 64 && position < message.Length; shift += 7)
        {
            var next = message[position++];
            value |= (ulong)(next & 0x7F) << shift;
            if ((next & 0x80) == 0)
            {
                return true;
            }
        }

        return false;
    }
}
