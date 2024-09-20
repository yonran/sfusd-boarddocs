import * as f from 'fp-ts';
import * as fsPromises from 'fs/promises';
import type * as t from 'io-ts';
import pr from 'io-ts/PathReporter';
import * as path from 'path';

export async function fileExists(p: string): Promise<boolean> {
    return fsPromises.stat(p).then(
        (x) => true,
        (err) => {
            if (err.code === 'ENOENT') return false;
            else throw err;
        }
    );
}
export async function writeJson<A>(p: string, json: A, typeC: t.Type<A, A, unknown>): Promise<void> {
    const validate = typeC.decode(json);
    if (f.either.isLeft(validate)) {
        throw Error('Bad argument to writeJson ' + p + ': ' + pr.PathReporter.report(validate).join('\n'));
    }
    const jsonString = JSON.stringify(json, undefined, 2);
    await fsPromises.mkdir(path.dirname(p), { recursive: true });
    await fsPromises.writeFile(p, jsonString, { encoding: 'utf-8' });
}
export async function parseFile<A>(p: string, typeC: t.Type<A, A, unknown>): Promise<A> {
    const validate = typeC.decode(
        JSON.parse(
            await fsPromises.readFile(p, {
                encoding: 'utf-8',
            })
        )
    );
    if (f.either.isLeft(validate)) {
        throw Error('could not parse ' + p + ': ' + pr.PathReporter.report(validate).join('\n'));
    } else {
        return validate.right;
    }
}
