import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import trendlyne_overview_fetcher as tof


def test_extract_company_description_reads_the_field():
    body = {"companyProfileData": {"companyDescription": "Bharat Electronics Limited manufactures..."}}
    assert tof.extract_company_description(body) == "Bharat Electronics Limited manufactures..."


def test_extract_company_description_returns_none_when_missing():
    assert tof.extract_company_description({}) is None
    assert tof.extract_company_description({"companyProfileData": {}}) is None
