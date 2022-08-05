/**
 * Service to handle Trusted CAs
 */
class TrustedCAService {
  /**
   * The dependencies are injected through the constructor
   */
  constructor({
    trustedCAModel, certificateModel, tenant, pkiUtils, dnUtils,
    rootCA, externalCaCertMinimumValidityDays, queryMaxTimeMS, caCertLimit,
    errorTemplate, trustedCANotifier,
  }) {
    Object.defineProperty(this, 'tenant', { value: tenant });
    Object.defineProperty(this, 'pkiUtils', { value: pkiUtils });
    Object.defineProperty(this, 'dnUtils', { value: dnUtils });
    Object.defineProperty(this, 'rootCA', { value: rootCA });
    Object.defineProperty(this, 'queryMaxTimeMS', { value: queryMaxTimeMS });
    Object.defineProperty(this, 'externalCaCertMinimumValidityDays', { value: externalCaCertMinimumValidityDays });

    Object.defineProperty(this, 'TrustedCAModel', { value: trustedCAModel.model });
    Object.defineProperty(this, 'parseTrustedCACndtFlds', { value: trustedCAModel.parseConditionFields.bind(trustedCAModel) });

    Object.defineProperty(this, 'CertificateModel', { value: certificateModel.model });
    Object.defineProperty(this, 'parseCertCndtFlds', { value: certificateModel.parseConditionFields.bind(certificateModel) });
    Object.defineProperty(this, 'caCertLimit', { value: caCertLimit });

    Object.defineProperty(this, 'error', { value: errorTemplate });
    Object.defineProperty(this, 'trustedCANotifier', { value: trustedCANotifier });
  }

  /**
   * Retrieves a trusted CA certificate from the database.
   *
   * @param {object} queryFields Certificate fields that must be returned in the record
   * @param {object} filterFields Filter fields to find the correct certificate in the database
   *
   * @returns Returns the record that represents the certificate in the database
   *
   * @throws an exception if no record is found with the informed filters.
   */
  async getCertificate(queryFields, filterFields) {
    Object.assign(filterFields, { tenant: this.tenant });

    /* Executes the query and converts the result to JSON */
    const result = await this.TrustedCAModel.findOne(filterFields)
      .select(queryFields.join(' '))
      .maxTimeMS(this.queryMaxTimeMS)
      .lean()
      .exec();
    if (!result) {
      throw this.error.NotFound(`No records found for the following parameters: ${JSON.stringify(filterFields)}`);
    }
    return result;
  }

  /**
   * Retrieves from the database a set of trusted CA certificates that meet the search criteria.
   *
   * @param {object} queryFields Certificate fields that must be returned in each record.
   * @param {object} filterFields Filter fields to find the correct certificates in the database.
   * @param {number} limit Limit of records that must be returned.
   * @param {number} offset Offset in relation to the first record found by the query.
   *
   * @returns a set of certificates that meet the search criteria.
   */
  async listCertificates(queryFields, filterFields, limit, offset, sortBy) {
    Object.assign(filterFields, { tenant: this.tenant });

    const query = this.TrustedCAModel.find(filterFields)
      .select(queryFields.join(' '))
      .limit(limit).skip(offset)
      .maxTimeMS(this.queryMaxTimeMS)
      .lean()

    if(sortBy) {
      query.sort(sortBy)
    }

    /* Executes the query and converts the results to JSON */
    const [results, itemCount] = await Promise.all([
      query.exec(),
      this.TrustedCAModel.countDocuments(filterFields),
    ]);
    
    return { itemCount, results };
  }

  /**
   * Retrieves the bundle of trusted CA certificates registered by all tenants.
   * Repeated certificates are discarded.
   *
   * @returns Returns a certificate bundle (array of certificates in PEM format).
   */
  async getCertificateBundle() {
    const result = await this.TrustedCAModel.aggregate().group({
      _id: '$caFingerprint',
      caPem: {
        $first: '$caPem',
      },
    }).exec();

    return result.map((el) => el.caPem);
  }

  /**
   * Register an external trusted root CA certificate (not generated by this service).
   *
   * @param {object} Object with the root CA certificate.
   *
   * @returns the fingerprint of the registered certificate.
   */
  async registerCertificate({ caPem, allowAutoRegistration }) {
    const caCert = this.pkiUtils.parseCert(caPem);
    const caFingerprint = this.pkiUtils.getFingerprint(caPem);

    this.pkiUtils.checkRemainingDays(caCert, this.externalCaCertMinimumValidityDays);

    await this.pkiUtils.assertRootCA(caCert);

    this.pkiUtils.checkRootExternalCN(caCert, this.rootCA);

    await this.checkCACertLimitByTenant();

    await this.checkExistingCertificate(caFingerprint);

    // Register the certificate in the database
    const subjectDN = this.dnUtils.from(caCert.subject).stringify();
    const model = new this.TrustedCAModel({
      caFingerprint,
      caPem,
      subjectDN,
      validity: {
        notBefore: caCert.notBefore.value,
        notAfter: caCert.notAfter.value,
      },
      allowAutoRegistration,
      tenant: this.tenant,
    });
    const caCertRecord = await model.save();

    // Notifies the creation of a record for a trusted CA
    await this.trustedCANotifier.creation(caCertRecord);

    return { caFingerprint };
  }

  /**
   * Defines whether certificates signed by the external CA can be automatically registered or not.
   *
   * @param {object} filterFields Filter fields to find the correct record in the database.
   * @param {boolean} allowAutoRegistration signed certs can be automatically registered or not.
   *
   * @throws an exception if no record is found with the entered filters.
   */
  async changeAutoRegistration(filterFields, allowAutoRegistration) {
    Object.assign(filterFields, { tenant: this.tenant });

    const result = await this.TrustedCAModel.findOneAndUpdate(
      filterFields, { allowAutoRegistration, modifiedAt: new Date() },
    ).maxTimeMS(this.queryMaxTimeMS).exec();

    if (!result) {
      throw this.error.NotFound(`No records found for the following parameters: ${JSON.stringify(filterFields)}`);
    }
  }

  /**
   * Removes an external trusted root CA certificate from the database.
   *
   * @param {object} caCertRecord Record that represents the certificate in
   *                       the database and that must be removed.
   */
  async deleteCertificate(caCertRecord) {
    const { caFingerprint } = caCertRecord;
    const { tenant } = this;

    const ff = this.parseCertCndtFlds({ tenant, caFingerprint, autoRegistered: false });
    const certCount = await this.CertificateModel.countDocuments(ff);
    if (certCount > 0) {
      throw this.error.BadRequest('There are certificates dependent on the CA to be removed, '
      + "however these certificates are not marked as 'autoRegistered'. Therefore, "
      + 'they must be removed manually before removing their CA certificate.');
    }

    // When we start using MongoDB >= 4.4 we can use transactions here...
    await this.CertificateModel.deleteMany({ tenant, caFingerprint, autoRegistered: true })
      .maxTimeMS(this.queryMaxTimeMS)
      .exec();

    /* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
    await this.TrustedCAModel.findByIdAndDelete(caCertRecord._id)
      .maxTimeMS(this.queryMaxTimeMS)
      .exec();

    // Notifies the removal of a record to a trusted CA
    await this.trustedCANotifier.removal(caCertRecord);
  }

  /**
   * checks the CA certificates limit that can be registered by tenant.
   *
   * @throws an exception if the maximum number has already been reached and
   * a new certificate is trying to be inserted.
   */
  async checkCACertLimitByTenant() {
    if (this.caCertLimit > -1) {
      const filterFields = { tenant: this.tenant };

      const count = await this.TrustedCAModel.countDocuments(filterFields);

      if (count >= this.caCertLimit) {
        throw this.error.BadRequest('The number of registered CAs has been exceeded.');
      }
    }
  }

  /**
   * Checks if there is already a certificate registered in the database with
   * the same fingerprint informed by parameter.
   *
   * @param {string} fingerprint fingerprint to be used as a query filter.
   *
   * @throws an exception if there is already a certificate registered in the
   * database with the same fingerprint informed by parameter.
   */
  async checkExistingCertificate(fingerprint) {
    const filterFields = {
      caFingerprint: fingerprint,
      tenant: this.tenant,
    };
    const count = await this.TrustedCAModel.countDocuments(filterFields);
    if (count) {
      throw this.error.Conflict(`The certificate with fingerprint '${fingerprint}' already exists.`);
    }
  }

  /**
   * Obtains the PEM from the trusted CA certificate registered on the platform.
   *
   * @param {string} caFingerprint to be used as a query filter.
   *
   * @returns the CA certificate in PEM format.
   */
  async getPEM(caFingerprint) {
    const ff = this.parseTrustedCACndtFlds({ tenant: this.tenant, caFingerprint });
    const result = await this.TrustedCAModel.findOne(ff)
      .select('caPem').maxTimeMS(this.queryMaxTimeMS).lean()
      .exec();
    if (result) {
      const { caPem } = result;
      return caPem;
    }
    throw new Error('No certificate found matching the provided fingerprint.');
  }
}

module.exports = TrustedCAService;
