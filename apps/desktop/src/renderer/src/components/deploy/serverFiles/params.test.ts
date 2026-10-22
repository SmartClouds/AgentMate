import { describe, expect, it } from 'vitest';
import { fileManagerId, filesChoice, filesParams, serverFilesHref } from './params';

/**
 * Where the Files section of a Deploy server points (E27): the server's own disk, a container or
 * a volume, kept in the page address next to the server and the section.
 */

const params = (search: string) => new URLSearchParams(search);

describe('filesChoice', () => {
  it('starts on the server disk when the server is reached over SSH', () => {
    expect(filesChoice(params('server=srv-1&view=files'), { sshDisk: true })).toEqual({
      source: 'server',
      target: null,
    });
  });

  it('starts on containers where there is no SSH, such as the DevHost', () => {
    expect(filesChoice(params('server=devhost&view=files'), { sshDisk: false })).toEqual({
      source: 'container',
      target: null,
    });
    expect(
      filesChoice(params('server=devhost&view=files&source=server'), { sshDisk: false }),
    ).toEqual({ source: 'container', target: null });
  });

  it('reads a container or a volume and its name', () => {
    expect(
      filesChoice(params('view=files&source=container&target=shop-api-1'), { sshDisk: true }),
    ).toEqual({ source: 'container', target: 'shop-api-1' });
    expect(
      filesChoice(params('view=files&source=volume&target=shop_db-data'), { sshDisk: true }),
    ).toEqual({ source: 'volume', target: 'shop_db-data' });
  });

  it('ignores a source it does not know, and a target on the server disk', () => {
    expect(filesChoice(params('source=pod&target=x'), { sshDisk: true })).toEqual({
      source: 'server',
      target: null,
    });
    expect(filesChoice(params('source=server&target=x'), { sshDisk: true })).toEqual({
      source: 'server',
      target: null,
    });
    expect(filesChoice(params('source=volume&target='), { sshDisk: true })).toEqual({
      source: 'volume',
      target: null,
    });
  });
});

describe('filesParams and serverFilesHref', () => {
  it('writes the server, the section, the source and the target', () => {
    expect(filesParams('srv-1', { source: 'container', target: 'shop-api-1' })).toEqual({
      server: 'srv-1',
      view: 'files',
      source: 'container',
      target: 'shop-api-1',
    });
    expect(filesParams('srv-1', { source: 'volume', target: null })).toEqual({
      server: 'srv-1',
      view: 'files',
      source: 'volume',
    });
    expect(filesParams('srv-1', { source: 'server', target: 'ignored' })).toEqual({
      server: 'srv-1',
      view: 'files',
      source: 'server',
    });
  });

  it('builds a link to the section', () => {
    expect(serverFilesHref('srv-1', { source: 'volume', target: 'shop_db-data' })).toBe(
      '/deploy?server=srv-1&view=files&source=volume&target=shop_db-data',
    );
  });
});

describe('fileManagerId', () => {
  it('is the server id for its disk', () => {
    expect(fileManagerId('srv-1', { source: 'server', target: null })).toBe('srv-1');
  });

  it('is a Docker target id for a container or volume', () => {
    expect(fileManagerId('srv-1', { source: 'container', target: 'shop-api-1' })).toBe(
      'docker~srv-1~container~shop-api-1',
    );
    expect(fileManagerId('srv-1', { source: 'volume', target: 'shop_db-data' })).toBe(
      'docker~srv-1~volume~shop_db-data',
    );
  });

  it('is null with no target, or a name Docker would never give', () => {
    expect(fileManagerId('srv-1', { source: 'container', target: null })).toBeNull();
    expect(fileManagerId('srv-1', { source: 'volume', target: '../etc' })).toBeNull();
    expect(fileManagerId('srv-1', { source: 'volume', target: 'a~b' })).toBeNull();
  });
});
