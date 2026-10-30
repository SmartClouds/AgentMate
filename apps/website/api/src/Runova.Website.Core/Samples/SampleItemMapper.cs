using Riok.Mapperly.Abstractions;

namespace Runova.Website.Core.Samples;

[Mapper]
public static partial class SampleItemMapper
{
    public static partial SampleItemDto ToDto(SampleItem item);
}
