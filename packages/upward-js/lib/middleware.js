const { readFile: fsReadFile } = require('fs');
const { promisify } = require('util');
const readFile = promisify(fsReadFile);
const jsYaml = require('js-yaml');
const Context = require('./Context');
const ResolverTree = require('./ResolverTree');
const UpwardServerError = require('./UpwardServerError');
const debug = require('debug')('upward-js:middleware');

class UpwardMiddleware {
    constructor(upwardPath, fs, fetch) {
        this.upwardPath = upwardPath;
        debug(`created for path ${upwardPath}`);
        this.fs = fs;
        this.fetch = fetch;
    }
    async load() {
        const { upwardPath } = this;
        try {
            this.yamlTxt = await readFile(upwardPath);
        } catch (e) {
            throw new UpwardServerError(e, `unable to read file ${upwardPath}`);
        }
        debug(`read upward.yml file successfully`);
        try {
            this.yaml = await jsYaml.safeLoad(this.yamlTxt);
        } catch (e) {
            throw new UpwardServerError(
                e,
                `error parsing ${upwardPath} contents: \n\n${this.yamlTxt}`
            );
        }
        debug(`parsed upward.yml file successfully: %o`, this.yaml);
        this.resolverTree = new ResolverTree(this.yaml);
        debug(`created resolverTree`);
        this.initialContext = Context.forStartup(process.env);
        await this.resolverTree.prepareForRequests(this.initialContext);
        debug(`resolverTree prepared for requests`);
    }
    async getHandler() {
        debug('returned handler');
        return async (req, res, next) => {
            const context = Context.forRequest(
                this.initialContext,
                req.originalUrl,
                req.headers
            );
            debug('created base request context: %o', context.toJSON());
            try {
                await this.resolverTree.resolveToResponse(context);
            } catch (e) {
                res.status(500).send(e.stack);
                next();
            }
            debug('resolved response context: %o', context.toJSON());
            let errors = [];
            const status = Number(context.get('status'));
            if (isNaN(status)) {
                errors.push(
                    `Non-numeric status! Status was '${context.status}'`
                );
            }
            const headers = context.get('headers');
            if (typeof headers !== 'object') {
                errors.push(
                    `Resolved with a non-compliant headers object! Headers are: ${headers}`
                );
            }
            const body = context.get('body');
            if (typeof body !== 'string') {
                errors.push(
                    `Resolved with a non-string body! Body was '${body}'`
                );
            }
            if (errors.length > 0) {
                res.status(500).send(
                    new UpwardServerError(
                        `Request did not evaluate to a valid response, because: \n${errors.join(
                            '\n'
                        )}`
                    ).toString()
                );
                next();
            }
            debug('status, headers, and body valid. responding');
            res.status(status)
                .set(headers)
                .send(body);
        };
    }
}

module.exports = async function upwardJSMiddlewareFactory(upwardPath) {
    const middleware = new UpwardMiddleware(upwardPath);
    await middleware.load();
    return middleware.getHandler();
};
