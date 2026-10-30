using Riok.Mapperly.Abstractions;

// Every mapper in this assembly: a DTO property with no source fails the build (warnings are
// errors), while source properties a DTO leaves out, such as hashes, need no ignore list.
[assembly: MapperDefaults(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
